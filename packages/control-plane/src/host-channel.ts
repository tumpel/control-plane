import { DurableObject } from "cloudflare:workers";
import { CloseCode } from "@tumpel/schemas";
import host0001 from "../migrations/host/0001_host.sql";
import host0002 from "../migrations/host/0002_host_without_tenant.sql";
import * as control from "./channel/control.ts";
import {
  type ControlEnvelope,
  emptyLedger,
  type HostMessage,
  type HostUsage,
  type Ledger,
  type LedgerStore,
  type StoredControlMessage,
  type TelemetryBatch,
} from "./channel/protocol.ts";
import { migrateDurableObject } from "./durable-migrate";
import { problem } from "./http";
import type { Env } from "./index";
import { settingsOf } from "./settings";
import { isSupervisorUpdate } from "./supervisor-updates";
import type { HostReply, TurnHandoff } from "./tenant-sessions";

const HOST_MIGRATIONS = [
  { name: "0001_host", sql: host0001 },
  { name: "0002_host_without_tenant", sql: host0002 },
];
const CLOSE_REASON_LIMIT = 120;

interface HostRow {
  host_id: string;
  public_key: string;
  revoked: number;
}

interface Attachment {
  connection: control.ControlConnection;
  lastReceivedAt: number;
  lastSentAt: number;
}

type Presence = "Online" | "Offline";

const isAttachment = (value: unknown): value is Attachment =>
  typeof value === "object" &&
  value !== null &&
  "connection" in value &&
  "lastReceivedAt" in value &&
  typeof value.lastReceivedAt === "number" &&
  "lastSentAt" in value &&
  typeof value.lastSentAt === "number";

export class HostChannel extends DurableObject<Env> {
  private tenantId: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateDurableObject(ctx.storage.sql, HOST_MIGRATIONS);
    });
  }

  register(hostId: string, publicKey: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO host (host_id, public_key, revoked) VALUES (?, ?, 0)",
      hostId,
      publicKey,
    );
  }

  revoke(reason: string): void {
    const host = this.host();
    if (host === null) throw new Error("revoke reached a host object that was never registered");
    this.ctx.storage.sql.exec("UPDATE host SET revoked = 1");
    for (const socket of this.ctx.getWebSockets()) {
      control.revoke(this.context(socket, { ...host, revoked: 1 }, this.attachment(socket)), reason);
    }
  }

  releasePublished(releaseVersion: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const attachment = this.attachment(socket);
      if (attachment.connection.phase !== "Open") continue;
      this.port(socket, attachment).send({ type: "ReleasePublished", releaseVersion });
      socket.serializeAttachment(attachment);
    }
  }

  async send(message: StoredControlMessage): Promise<void> {
    const host = this.host();
    if (host === null) throw new Error(`a ${message.type} reached a host object that was never registered`);
    const open = this.ctx
      .getWebSockets()
      .find(
        (socket) =>
          socket.readyState === WebSocket.READY_STATE_OPEN && this.attachment(socket).connection.phase === "Open",
      );
    if (open === undefined) {
      await control.send({ phase: "Closed" }, message, this.context(null, host, null));
      return;
    }
    const attachment = this.attachment(open);
    await control.send(attachment.connection, message, this.context(open, host, attachment));
    open.serializeAttachment(attachment);
  }

  override async fetch(request: Request): Promise<Response> {
    const host = this.host();
    if (host === null) {
      return problem(404, {
        code: "NotFound",
        title: "Host not found",
        detail: `no host is enrolled under ${new URL(request.url).pathname}`,
        fix: "Enrol the host with tumpel-supervisor enrol",
      });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return problem(400, {
        code: "InvalidRequest",
        title: "Not a WebSocket",
        detail: "the host channel answers WebSocket upgrades only",
        fix: "Connect with tumpel-supervisor run",
      });
    }
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    const attachment: Attachment = { connection: { phase: "Closed" }, lastReceivedAt: now, lastSentAt: now };
    attachment.connection = control.challenge(this.port(server, attachment));
    server.serializeAttachment(attachment);
    await this.ctx.storage.setAlarm(now + this.deadlineMs());
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const host = this.host();
    if (host === null) throw new Error("a message reached a host object that was never registered");
    const attachment = this.attachment(socket);
    const context = this.context(socket, host, attachment);
    if (typeof message !== "string") {
      control.close(context.port, CloseCode.ProtocolError, "channel messages are JSON text, not binary");
      return this.refreshPresence(socket);
    }
    const now = Date.now();
    attachment.lastReceivedAt = now;
    const { connection, event } = await control.receive(attachment.connection, message, context);
    attachment.connection = connection;
    this.keep(socket, attachment);
    if (event.kind === "Message") {
      const { message: received } = event;
      const handoff = await this.ctx.blockConcurrencyWhile(async (): Promise<TurnHandoff | null> => {
        const reply = await this.forward(host.host_id, received);
        if (reply === null) return null;
        if (reply.type === "TurnHandoff") return reply;
        await control.send(attachment.connection, reply, context);
        return null;
      });
      if (handoff !== null) await this.env.HOST.get(this.env.HOST.idFromName(handoff.hostId)).send(handoff.offer);
    }
    if (event.kind === "FrameRefused") {
      console.error(`FrameRefused: host ${host.host_id} frame ${event.seq}: ${event.reason}`);
    }
    if (event.kind === "Closed") return this.refreshPresence(socket);
    if (event.kind === "Heartbeat") await this.report(host.host_id, event.usage, now);
    if (event.kind === "Welcomed") await this.hello(host.host_id, event, now);
    if (
      connection.phase === "Open" &&
      now - attachment.lastSentAt >= (settingsOf(this.env).heartbeatIntervalSeconds * 1000) / 2
    )
      control.beat(context);
    this.keep(socket, attachment);
    await this.ctx.storage.setAlarm(attachment.lastReceivedAt + this.deadlineMs());
    if (event.kind !== "Welcomed") return;
    for (const other of this.ctx.getWebSockets()) {
      if (other !== socket) other.close(CloseCode.Replaced, "a newer connection from this host replaced this one");
    }
    await this.presence("Online");
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    await this.refreshPresence(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.refreshPresence(socket);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const deadlineMs = this.deadlineMs();
    const live: number[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const { lastReceivedAt } = this.attachment(socket);
      if (now - lastReceivedAt < deadlineMs) {
        live.push(lastReceivedAt);
        continue;
      }
      socket.close(CloseCode.HeartbeatDeadline, `nothing arrived for ${deadlineMs / 1000} seconds; reconnect`);
    }
    await this.refreshPresence();
    if (live.length > 0) await this.ctx.storage.setAlarm(Math.min(...live) + deadlineMs);
  }

  private keep(socket: WebSocket, attachment: Attachment): void {
    attachment.lastReceivedAt = Math.max(attachment.lastReceivedAt, this.attachment(socket).lastReceivedAt);
    socket.serializeAttachment(attachment);
  }

  private deadlineMs(): number {
    return settingsOf(this.env).heartbeatDeadlineSeconds * 1000;
  }

  private async hello(hostId: string, welcomed: control.Welcomed, now: number): Promise<void> {
    await this.env.DB.prepare("UPDATE hosts SET supervisor_version = ?, updated_at = ? WHERE host_id = ?")
      .bind(welcomed.supervisorVersion, now, hostId)
      .run();
    const tenantId = await this.tenantOf(hostId);
    await this.env.TENANT.getByName(tenantId).hostHello(
      hostId,
      welcomed.boxCapacity,
      welcomed.usage,
      now,
      welcomed.protocolVersion,
    );
  }

  private async report(hostId: string, usage: HostUsage, now: number): Promise<void> {
    const tenantId = await this.tenantOf(hostId);
    await this.env.TENANT.getByName(tenantId).hostUsage(hostId, usage, now);
  }

  private async tenantOf(hostId: string): Promise<string> {
    if (this.tenantId !== undefined) return this.tenantId;
    const row = await this.env.DB.prepare("SELECT tenant_id FROM hosts WHERE host_id = ?")
      .bind(hostId)
      .first<{ tenant_id: string }>();
    if (row === null) throw new Error(`host ${hostId} has a channel but no row in the hosts table; enrol it again`);
    this.tenantId = row.tenant_id;
    return row.tenant_id;
  }

  private async forward(hostId: string, message: HostMessage): Promise<HostReply | null> {
    const tenantId = await this.tenantOf(hostId);
    if (message.type === "TelemetryBatch") {
      await this.telemetry(tenantId, hostId, message);
      return null;
    }
    const tenant = this.env.TENANT.getByName(tenantId);
    if (isSupervisorUpdate(message)) {
      if (message.type === "SupervisorUpdateStep" && message.phase === "WaitingForIdle") return null;
      await tenant.supervisorUpdate(hostId, message);
      if (message.type === "SupervisorUpdateStep" && message.phase === "Restarting") await this.presence("Offline");
      else await this.refreshPresence();
      return null;
    }
    return tenant.hostMessage(tenantId, hostId, message);
  }

  private async telemetry(
    tenantId: string,
    hostId: string,
    { instruments, samples, turns }: TelemetryBatch,
  ): Promise<void> {
    const signed = <Point extends { dimensions: Record<string, string> }>(point: Point): Point => ({
      ...point,
      dimensions: { ...point.dimensions, hostId },
    });
    await this.env.TENANT_METRICS.getByName(tenantId)
      .record({ instruments, samples: samples.map(signed), turns: turns.map(signed) })
      .catch((error: unknown) => {
        console.error(
          `TelemetryRejected: host ${hostId} sent a telemetry batch the metrics store refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private host(): HostRow | null {
    const [row] = this.ctx.storage.sql
      .exec<{ host_id: string; public_key: string; revoked: number }>("SELECT host_id, public_key, revoked FROM host")
      .toArray();
    return row ?? null;
  }

  private attachment(socket: WebSocket): Attachment {
    const attachment: unknown = socket.deserializeAttachment();
    if (!isAttachment(attachment)) throw new Error("a host channel socket carries no connection state");
    return attachment;
  }

  private port(socket: WebSocket | null, attachment: Attachment | null): control.ControlContext["port"] {
    if (socket === null || attachment === null) {
      return {
        send: (envelope: ControlEnvelope) => {
          throw new Error(`a ${envelope.type} was sent to a host with no open connection`);
        },
        close: () => undefined,
      };
    }
    return {
      send: (envelope: ControlEnvelope) => {
        socket.send(JSON.stringify(envelope));
        attachment.lastSentAt = Date.now();
      },
      close: (code: number, reason: string) => socket.close(code, reason.slice(0, CLOSE_REASON_LIMIT)),
    };
  }

  private ledger(): LedgerStore<StoredControlMessage> {
    const sql = this.ctx.storage.sql;
    return {
      load: async (): Promise<Ledger<StoredControlMessage>> => {
        const [row] = sql
          .exec<{ received: number; sent: number; unacked: string }>(
            "SELECT received, sent, unacked FROM ledger WHERE ledger_id = 1",
          )
          .toArray();
        if (row === undefined) return emptyLedger();
        return { received: row.received, sent: row.sent, unacked: JSON.parse(row.unacked) };
      },
      save: async (ledger: Ledger<StoredControlMessage>): Promise<void> => {
        sql.exec(
          "INSERT OR REPLACE INTO ledger (ledger_id, received, sent, unacked) VALUES (1, ?, ?, ?)",
          ledger.received,
          ledger.sent,
          JSON.stringify(ledger.unacked),
        );
      },
    };
  }

  private context(socket: WebSocket | null, host: HostRow, attachment: Attachment | null): control.ControlContext {
    return {
      port: this.port(socket, attachment),
      host: { hostId: host.host_id, publicKey: host.public_key, revoked: host.revoked === 1 },
      ledger: this.ledger(),
      prepareOffer: async (offer) => {
        const tenantId = await this.tenantOf(host.host_id);
        return this.env.TENANT.getByName(tenantId).prepareOffer(tenantId, offer.turnId, host.host_id, Date.now());
      },
      prepareClaudeSetup: async (stored) => {
        const tenantId = await this.tenantOf(host.host_id);
        return this.env.TENANT.getByName(tenantId).prepareClaudeSetup(tenantId, stored, host.host_id, Date.now());
      },
      messageVersions: control.CONTROL_MESSAGE_VERSIONS,
      now: () => new Date(),
    };
  }

  private async refreshPresence(closing?: WebSocket): Promise<void> {
    const open = this.ctx
      .getWebSockets()
      .some(
        (socket) =>
          socket !== closing &&
          socket.readyState === WebSocket.READY_STATE_OPEN &&
          this.attachment(socket).connection.phase === "Open",
      );
    await this.presence(open ? "Online" : "Offline");
  }

  private async presence(state: Presence): Promise<void> {
    const host = this.host();
    if (host === null) throw new Error("presence changed on a host object that was never registered");
    const now = Date.now();
    const changed = await this.env.DB.prepare(
      "UPDATE hosts SET state = ?, updated_at = ? WHERE host_id = ? AND state NOT IN ('Revoked', ?)",
    )
      .bind(state, now, host.host_id, state)
      .run();
    if (changed.meta.changes === 0) return;
    const tenantId = await this.tenantOf(host.host_id);
    await this.env.TENANT.getByName(tenantId).hostPresence(tenantId, host.host_id, state, now);
  }
}
