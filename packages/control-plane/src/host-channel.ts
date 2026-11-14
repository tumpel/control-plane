import { DurableObject } from "cloudflare:workers";
import { CloseCode } from "@tumpel/api/schemas";
import host0001 from "../migrations/host/0001_host.sql";
import host0002 from "../migrations/host/0002_host_without_tenant.sql";
import * as control from "./channel/control.ts";
import {
  type ControlEnvelope,
  type DispatchGrant,
  emptyLedger,
  HEARTBEAT_DEADLINE_MS,
  HEARTBEAT_INTERVAL_MS,
  type Ledger,
  type LedgerStore,
  type StoredControlMessage,
} from "./channel/protocol.ts";
import { migrateDurableObject } from "./durable-migrate";
import { problem } from "./http";
import type { Env } from "./index";

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
    await this.ctx.storage.setAlarm(now + HEARTBEAT_DEADLINE_MS);
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
    if (event.kind === "Message") {
      control.close(context.port, CloseCode.ProtocolError, `this control plane takes no ${event.message.type} yet`);
      return this.refreshPresence(socket);
    }
    if (event.kind === "Closed") return this.refreshPresence(socket);
    if (connection.phase === "Open" && now - attachment.lastSentAt >= HEARTBEAT_INTERVAL_MS / 2) control.beat(context);
    socket.serializeAttachment(attachment);
    await this.ctx.storage.setAlarm(now + HEARTBEAT_DEADLINE_MS);
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
    const live: number[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const { lastReceivedAt } = this.attachment(socket);
      if (now - lastReceivedAt < HEARTBEAT_DEADLINE_MS) {
        live.push(lastReceivedAt);
        continue;
      }
      socket.close(
        CloseCode.HeartbeatDeadline,
        `nothing arrived for ${HEARTBEAT_DEADLINE_MS / 1000} seconds; reconnect`,
      );
    }
    await this.refreshPresence();
    if (live.length > 0) await this.ctx.storage.setAlarm(Math.min(...live) + HEARTBEAT_DEADLINE_MS);
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

  private port(socket: WebSocket, attachment: Attachment): control.ControlContext["port"] {
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

  private context(socket: WebSocket, host: HostRow, attachment: Attachment): control.ControlContext {
    return {
      port: this.port(socket, attachment),
      host: { hostId: host.host_id, publicKey: host.public_key, revoked: host.revoked === 1 },
      ledger: this.ledger(),
      mintGrant: async (): Promise<DispatchGrant> => {
        throw new Error(
          `host ${host.host_id} has a turn offer to send, but this control plane mints no dispatch grants yet; deploy a control plane that holds provider keys`,
        );
      },
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
    await this.env.DB.prepare(
      "UPDATE hosts SET state = ?, updated_at = ? WHERE host_id = ? AND state NOT IN ('Revoked', ?)",
    )
      .bind(state, Date.now(), host.host_id, state)
      .run();
  }
}
