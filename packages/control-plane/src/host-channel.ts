import { DurableObject } from "cloudflare:workers";
import { CloseCode, HostHealthSchema } from "@tumpel/schemas";
import { z } from "zod";
import { errorOf } from "./backoff.ts";
import * as control from "./channel/control.ts";
import { refusal, resendable } from "./channel/failure.ts";
import { HostFrameMeter, type HostHealth, rateLimitDetail } from "./channel/host-health.ts";
import { HostLedger } from "./channel/ledger.ts";
import type { ControlEnvelope, Frame, HostMessage, MetricBatch, StoredControlMessage } from "./channel/protocol.ts";
import { durableDb } from "./db/client.ts";
import * as hostSchema from "./db/host-schema.ts";
import { migrateDurableObject } from "./durable-migrate";
import { HOST_MIGRATIONS } from "./host-migrations.ts";
import type { OfferSent } from "./hosts";
import { problem } from "./http";
import type { Env } from "./index";
import { hostLimitsOf, limitsOf } from "./limits.ts";
import { METRICS_LIMITS, metricBatches } from "./metrics-store.ts";
import { isSupervisorUpdate } from "./supervisor-updates";
import { tenantApi } from "./tenant-api.ts";
import type { HostReply } from "./tenant-sessions";
import { stampTurnPoints } from "./turn-metrics.ts";

const CLOSE_REASON_LIMIT = 120;
const STORE_FAILED = 1011;

interface HostRow {
  host_id: string;
  public_key: string;
  revoked: number;
}

interface Attachment {
  connection: control.ControlConnection;
  boxCapacity: number | null;
}

type Heartbeat = Extract<control.ControlEvent, { kind: "Heartbeat" }>;

type Handled = { kind: "Stored"; reply: HostReply | null } | { kind: "Unstored"; error: unknown };

const boxCapacityOf = (attachment: Attachment): number => {
  if (attachment.boxCapacity === null) throw new Error("a host channel took a Heartbeat on a connection with no Hello");
  return attachment.boxCapacity;
};

const isAttachment = (value: unknown): value is Attachment =>
  typeof value === "object" && value !== null && "connection" in value && "boxCapacity" in value;

export class HostChannel extends DurableObject<Env> {
  private tenantId: string | undefined;
  private inbound: Promise<void> = Promise.resolve();
  private readonly ledger: HostLedger;
  private meter: HostFrameMeter | null = null;
  private tripped: HostHealth | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = new HostLedger(durableDb(ctx.storage, hostSchema));
    void ctx.blockConcurrencyWhile(async () => {
      await migrateDurableObject(ctx.storage, HOST_MIGRATIONS);
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

  async send(message: StoredControlMessage): Promise<OfferSent> {
    const host = this.host();
    if (host === null) throw new Error(`a ${message.type} reached a host object that was never registered`);
    if (message.type === "TurnOffer") {
      const refused = await this.offerRefused(host.host_id);
      if (refused !== null) return refused;
    }
    if (this.openSocket() === undefined) {
      await control.send({ phase: "Closed" }, message, this.context(null, host, null));
      return "Sent";
    }
    const spoken = await control.prepare(message, this.context(null, host, null));
    const open = this.openSocket();
    if (message.type === "TurnOffer" && open === undefined) return "Offline";
    if (open === undefined) {
      await control.send({ phase: "Closed" }, message, this.context(null, host, null), spoken);
      return "Sent";
    }
    const attachment = this.attachment(open);
    const sent = control.send(attachment.connection, message, this.context(open, host, attachment), spoken);
    open.serializeAttachment(attachment);
    await sent;
    return "Sent";
  }

  private openSocket(): WebSocket | undefined {
    return this.ctx
      .getWebSockets()
      .find(
        (socket) =>
          socket.readyState === WebSocket.READY_STATE_OPEN && this.attachment(socket).connection.phase === "Open",
      );
  }

  private async offerRefused(hostId: string): Promise<OfferSent | null> {
    if ((await this.frameMeter(hostId)).health() !== "Healthy") return "RateLimited";
    if (this.openSocket() === undefined) return "Offline";
    return null;
  }

  async restoreHealth(detail: string): Promise<void> {
    const host = this.host();
    if (host === null) throw new Error("a health restore reached a host object that was never registered");
    const meter = await this.frameMeter(host.host_id);
    await this.setHealth(host.host_id, "Healthy", detail);
    meter.restore();
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
    await this.relimitFrames(host.host_id);
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { connection: { phase: "Closed" }, boxCapacity: null };
    attachment.connection = control.challenge(this.port(server, attachment));
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const handled = this.inbound.then(() => this.handle(socket, message));
    this.inbound = handled.then(
      () => undefined,
      () => undefined,
    );
    return handled;
  }

  private async handle(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const host = this.host();
    if (host === null) throw new Error("a message reached a host object that was never registered");
    const attachment = this.attachment(socket);
    const context = this.context(socket, host, attachment);
    if (typeof message !== "string") {
      control.close(context.port, CloseCode.ProtocolError, "channel messages are JSON text, not binary");
      return;
    }
    const now = Date.now();
    const meter = await this.frameMeter(host.host_id);
    const { connection, event } = await control.receive(attachment.connection, message, context);
    attachment.connection = connection;
    if (event.kind === "Welcomed") attachment.boxCapacity = event.boxCapacity;
    socket.serializeAttachment(attachment);
    if (this.tripped !== null) await this.trip(host.host_id, this.tripped, meter.framesPerMinute);
    if (event.kind === "FrameRefused") {
      console.error(`FrameRefused: host ${host.host_id} frame ${event.seq}: ${event.reason}`);
    }
    if (event.kind === "Message") return this.take(socket, host.host_id, event.frame, attachment, context);
    if (event.kind === "Heartbeat") return this.heartbeat(host.host_id, event, now, meter, attachment, context);
    if (event.kind !== "Welcomed") return;
    await this.hello(host.host_id, event, now);
    for (const other of this.ctx.getWebSockets()) {
      if (other !== socket) other.close(CloseCode.Replaced, "a newer connection from this host replaced this one");
    }
  }

  private async take(
    socket: WebSocket,
    hostId: string,
    frame: Frame<HostMessage>,
    attachment: Attachment,
    context: control.ControlContext,
  ): Promise<void> {
    const handled = await this.forward(hostId, frame.message).then(
      (reply): Handled => ({ kind: "Stored", reply }),
      (error: unknown): Handled =>
        resendable(error) ? { kind: "Unstored", error } : { kind: "Stored", reply: refusal(frame.message.type, error) },
    );
    if (handled.kind === "Unstored") {
      const reason = `the control plane failed to store frame ${frame.seq} (${frame.message.type}): ${errorOf(handled.error).message}`;
      console.error(`FrameUnstored: host ${hostId}: ${reason}`);
      control.close(context.port, STORE_FAILED, reason);
      return;
    }
    if (attachment.connection.phase !== "Open") return;
    attachment.connection = control.stored(attachment.connection, frame.seq, context);
    socket.serializeAttachment(attachment);
    await this.answer(hostId, frame, handled.reply, attachment, context);
    control.answered(attachment.connection, frame, context);
  }

  private async heartbeat(
    hostId: string,
    beat: Heartbeat,
    now: number,
    meter: HostFrameMeter,
    attachment: Attachment,
    context: control.ControlContext,
  ): Promise<void> {
    if (attachment.connection.phase !== "Open") return;
    if (meter.recovered(now)) {
      await this.setHealth(
        hostId,
        "Healthy",
        `host ${hostId} sent no more than ${meter.framesPerMinute} frames a minute for a full minute`,
      );
      meter.settle("Healthy");
    }
    const tenantId = await this.tenantOf(hostId);
    await this.telemetry(tenantId, hostId, beat.telemetry);
    await tenantApi(this.env.TENANT, tenantId)
      .call("hostHeartbeat", {
        tenantId,
        hostId,
        boxCapacity: boxCapacityOf(attachment),
        usage: beat.usage,
        reportedHealth: beat.reportedHealth,
        now,
        channelProtocol: attachment.connection.protocolVersion,
        heldSessionIds: beat.heldSessionIds,
        heldClaudeSetupIds: beat.heldClaudeSetupIds,
        heldTurnIds: beat.heldTurnIds,
      })
      .catch((error: unknown) => {
        console.error(
          `HeartbeatUnstored: host ${hostId}: ${errorOf(error).message}; the next heartbeat reports it again`,
        );
      });
    control.checkpoint(attachment.connection, context);
    control.beat(context);
  }

  private async answer(
    hostId: string,
    frame: Frame<HostMessage>,
    reply: HostReply | null,
    attachment: Attachment,
    context: control.ControlContext,
  ): Promise<void> {
    if (reply === null) return;
    if (reply.type === "TurnHandoff")
      throw new Error(`the tenant answered host ${hostId} with a TurnHandoff, which it sends itself`);
    if (reply.type === "Refused") {
      console.error(`FrameRefused: host ${hostId} frame ${frame.seq}: ${reply.reason}`);
      return control.refuseFrame(context.port, frame.seq, reply.reason);
    }
    return control.send(attachment.connection, reply, context);
  }

  private async hello(hostId: string, welcomed: control.Welcomed, now: number): Promise<void> {
    const db = this.env.DB;
    const { channelProtocolOldest, guestProtocol } = welcomed;
    await db.batch([
      db
        .prepare(
          "UPDATE hosts SET supervisor_version = ?1, updated_at = ?2 WHERE host_id = ?3 AND supervisor_version IS NOT ?1",
        )
        .bind(welcomed.supervisorVersion, now, hostId),
      channelProtocolOldest === undefined
        ? db.prepare("DELETE FROM host_channel_protocols WHERE host_id = ?").bind(hostId)
        : db
            .prepare(
              `INSERT INTO host_channel_protocols (host_id, channel_protocol_oldest, channel_protocol_version) VALUES (?, ?, ?)
              ON CONFLICT (host_id) DO UPDATE SET channel_protocol_oldest = excluded.channel_protocol_oldest,
                channel_protocol_version = excluded.channel_protocol_version
              WHERE host_channel_protocols.channel_protocol_oldest IS NOT excluded.channel_protocol_oldest
                OR host_channel_protocols.channel_protocol_version IS NOT excluded.channel_protocol_version`,
            )
            .bind(hostId, channelProtocolOldest, welcomed.protocolVersion),
      guestProtocol === undefined
        ? db.prepare("DELETE FROM host_guest_protocols WHERE host_id = ?").bind(hostId)
        : db
            .prepare(
              `INSERT INTO host_guest_protocols (host_id, guest_protocol_oldest, guest_protocol_version) VALUES (?, ?, ?)
              ON CONFLICT (host_id) DO UPDATE SET guest_protocol_oldest = excluded.guest_protocol_oldest,
                guest_protocol_version = excluded.guest_protocol_version
              WHERE host_guest_protocols.guest_protocol_oldest IS NOT excluded.guest_protocol_oldest
                OR host_guest_protocols.guest_protocol_version IS NOT excluded.guest_protocol_version`,
            )
            .bind(hostId, guestProtocol.guestProtocolOldest, guestProtocol.guestProtocolVersion),
    ]);
    const tenantId = await this.tenantOf(hostId);
    await tenantApi(this.env.TENANT, tenantId).call("hostHello", {
      tenantId,
      hostId,
      boxCapacity: welcomed.boxCapacity,
      usage: welcomed.usage,
      now,
      channelProtocol: welcomed.channelProtocol,
      heldTurnIds: welcomed.heldTurnIds,
    });
  }

  private async relimitFrames(hostId: string): Promise<void> {
    if (this.meter === null) return;
    const limits = await hostLimitsOf(this.env.DB, limitsOf(this.env), hostId);
    if (limits !== null) this.meter.relimit(limits.hostFramesPerMinute);
  }

  private async frameMeter(hostId: string): Promise<HostFrameMeter> {
    if (this.meter !== null) return this.meter;
    const row = await hostLimitsOf(this.env.DB, limitsOf(this.env), hostId);
    if (row === null) throw new Error(`host ${hostId} has a channel but no row in the hosts table; enrol it again`);
    const sql = this.ctx.storage.sql;
    const [saved] = sql.exec<{ trips: string }>("SELECT trips FROM frame_trips WHERE frame_trips_id = 1").toArray();
    const trips = z.array(z.number()).parse(saved === undefined ? [] : JSON.parse(saved.trips));
    this.meter ??= new HostFrameMeter(row.hostFramesPerMinute, HostHealthSchema.parse(row.health), trips, {
      save: (next) =>
        sql.exec(
          "INSERT INTO frame_trips (frame_trips_id, trips) VALUES (1, ?) ON CONFLICT (frame_trips_id) DO UPDATE SET trips = excluded.trips",
          JSON.stringify(next),
        ),
      clear: () => sql.exec("DELETE FROM frame_trips WHERE frame_trips_id = 1"),
    });
    return this.meter;
  }

  private async trip(hostId: string, health: HostHealth, framesPerMinute: number): Promise<void> {
    this.tripped = null;
    const over = rateLimitDetail(hostId, framesPerMinute);
    const detail =
      health === "Unhealthy"
        ? `${over} three times within an hour, so it gets no offers until a person restores its health`
        : `${over}, so the control plane failed its running work and offers it nothing until a full minute passes under the limit`;
    console.error(`Host${health}: ${detail}`);
    await this.setHealth(hostId, health, detail);
    (await this.frameMeter(hostId)).settle(health);
  }

  private async setHealth(hostId: string, health: HostHealth, detail: string): Promise<void> {
    const now = Date.now();
    const stored = await this.env.DB.prepare("SELECT health FROM hosts WHERE host_id = ?")
      .bind(hostId)
      .first<{ health: string }>();
    if (stored?.health === health) return;
    const tenantId = await this.tenantOf(hostId);
    await tenantApi(this.env.TENANT, tenantId).call("hostHealth", { tenantId, hostId, health, detail, now });
    await this.env.DB.prepare("UPDATE hosts SET health = ?1, updated_at = ?2 WHERE host_id = ?3 AND health IS NOT ?1")
      .bind(health, now, hostId)
      .run();
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
    const tenant = tenantApi(this.env.TENANT, tenantId);
    if (isSupervisorUpdate(message)) {
      if (message.type === "SupervisorUpdateStep" && message.phase === "WaitingForIdle") return null;
      await tenant.call("supervisorUpdate", { hostId, message });
      return null;
    }
    return (await tenant.call("hostMessage", { tenantId, hostId, message })).reply;
  }

  private async telemetry(
    tenantId: string,
    hostId: string,
    { instruments, samples, turns }: MetricBatch,
  ): Promise<void> {
    if (instruments.length === 0 && samples.length === 0 && turns.length === 0) return;
    const signed = <Point extends { dimensions: Record<string, string> }>(point: Point): Point => ({
      ...point,
      dimensions: { ...point.dimensions, hostId },
    });
    const turnIds = [...new Set(turns.map((point) => point.turnId))];
    const offered =
      turnIds.length === 0
        ? {}
        : (await tenantApi(this.env.TENANT, tenantId).call("turnMetricDimensions", { turnIds })).dimensions;
    const metrics = this.env.TENANT_METRICS.getByName(tenantId);
    const batch = { instruments, samples: samples.map(signed), turns: stampTurnPoints(turns, offered, hostId) };
    for (const part of metricBatches(batch, METRICS_LIMITS)) {
      await metrics.record(part).catch((error: unknown) => {
        console.error(
          `TelemetryRejected: host ${hostId} sent a telemetry batch the metrics store refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
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
      send: (envelope: ControlEnvelope) => socket.send(JSON.stringify(envelope)),
      close: (code: number, reason: string) => socket.close(code, reason.slice(0, CLOSE_REASON_LIMIT)),
    };
  }

  private context(socket: WebSocket | null, host: HostRow, attachment: Attachment | null): control.ControlContext {
    return {
      port: this.port(socket, attachment),
      host: { hostId: host.host_id, publicKey: host.public_key, revoked: host.revoked === 1 },
      ledger: this.ledger,
      prepareOffer: async (offer) => {
        const tenantId = await this.tenantOf(host.host_id);
        const { prepared } = await tenantApi(this.env.TENANT, tenantId).call("prepareOffer", {
          tenantId,
          turnId: offer.turnId,
          hostId: host.host_id,
          now: Date.now(),
        });
        return prepared;
      },
      prepareClaudeSetup: async (stored) => {
        const tenantId = await this.tenantOf(host.host_id);
        const { prepared } = await tenantApi(this.env.TENANT, tenantId).call("prepareClaudeSetup", {
          tenantId,
          stored,
          hostId: host.host_id,
          now: Date.now(),
        });
        return prepared;
      },
      messageVersions: control.CONTROL_MESSAGE_VERSIONS,
      admitFrame: (seq) => {
        if (this.meter === null) throw new Error("a frame reached the host channel before its frame meter loaded");
        const admission = this.meter.admit(seq, Date.now());
        if (admission.kind === "Admitted") return null;
        if (admission.tripped !== null) this.tripped = admission.tripped;
        const retryAfter = new Date(admission.retryAfter);
        return {
          reason: `${rateLimitDetail(host.host_id, admission.framesPerMinute)}, so the control plane recorded nothing of this frame; send no frames until ${retryAfter.toISOString()}`,
          framesPerMinute: admission.framesPerMinute,
          retryAfter,
        };
      },
      now: () => new Date(),
    };
  }
}
