import { DurableObject } from "cloudflare:workers";
import { CloseCode, HostHealthSchema } from "@tumpel/schemas";
import { z } from "zod";
import { errorOf, RETRY_LIMIT } from "./backoff.ts";
import * as control from "./channel/control.ts";
import { lost, refusedOrResent, resendable } from "./channel/failure.ts";
import { HostFrameMeter, type HostHealth, rateLimitDetail } from "./channel/host-health.ts";
import { HostLedger } from "./channel/ledger.ts";
import type { ControlEnvelope, Frame, HostMessage, StoredControlMessage, TelemetryBatch } from "./channel/protocol.ts";
import { durableDb } from "./db/client.ts";
import * as hostSchema from "./db/host-schema.ts";
import { migrateDurableObject } from "./durable-migrate";
import { HOST_MIGRATIONS } from "./host-migrations.ts";
import type { OfferSent } from "./hosts";
import { problem } from "./http";
import type { Env } from "./index";
import { hostLimitsOf, limitsOf } from "./limits.ts";
import { METRICS_LIMITS, metricBatches } from "./metrics-store.ts";
import { settingsOf } from "./settings";
import { isSupervisorUpdate } from "./supervisor-updates";
import { tenantApi } from "./tenant-api.ts";
import type { HostReply } from "./tenant-sessions";
import { stampTurnPoints } from "./turn-metrics.ts";

const CLOSE_REASON_LIMIT = 120;

interface HostRow {
  host_id: string;
  public_key: string;
  revoked: number;
}

interface Attachment {
  connection: control.ControlConnection;
  lastSentAt: number;
  boxCapacity: number | null;
  heldFrom: number | null;
}

type Heartbeat = Extract<control.ControlEvent, { kind: "Heartbeat" }>;

type Delivered = { ok: true; reply: HostReply | null } | { ok: false };

const boxCapacityOf = (attachment: Attachment): number => {
  if (attachment.boxCapacity === null) throw new Error("a host channel took a Heartbeat on a connection with no Hello");
  return attachment.boxCapacity;
};

const isAttachment = (value: unknown): value is Attachment =>
  typeof value === "object" &&
  value !== null &&
  "connection" in value &&
  "lastSentAt" in value &&
  typeof value.lastSentAt === "number" &&
  "boxCapacity" in value &&
  "heldFrom" in value;

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
    const now = Date.now();
    const attachment: Attachment = {
      connection: { phase: "Closed" },
      lastSentAt: now,
      boxCapacity: null,
      heldFrom: null,
    };
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
    if (attachment.heldFrom !== null && !this.ledger.holding()) {
      control.close(
        context.port,
        CloseCode.ProtocolError,
        `the control plane slept and lost frames ${attachment.heldFrom} onward before it stored them; reconnect and resend them`,
      );
      return;
    }
    const now = Date.now();
    const meter = await this.frameMeter(host.host_id);
    const { connection, event } = await control.receive(attachment.connection, message, context);
    attachment.connection = connection;
    if (event.kind === "Welcomed") {
      this.ledger.take();
      attachment.boxCapacity = event.boxCapacity;
    }
    this.keep(socket, attachment);
    if (this.tripped !== null) await this.trip(host.host_id, this.tripped, meter.framesPerMinute);
    if (event.kind === "Heartbeat") {
      if (meter.recovered(now)) {
        await this.setHealth(
          host.host_id,
          "Healthy",
          `host ${host.host_id} sent no more than ${meter.framesPerMinute} frames a minute for a full minute`,
        );
        meter.settle("Healthy");
      }
    }
    if (event.kind === "Message") await this.take(host.host_id, event.frame, attachment, context);
    if (event.kind === "FrameRefused") {
      console.error(`FrameRefused: host ${host.host_id} frame ${event.seq}: ${event.reason}`);
    }
    if (event.kind === "Closed") return;
    if (event.kind === "Heartbeat") {
      if (
        !(await this.heartbeat(host.host_id, event, now, attachment, context)) &&
        this.ledger.stalled() >= RETRY_LIMIT
      )
        return this.giveUp(attachment, context);
      if (attachment.connection.phase === "Closed") return;
    }
    if (event.kind === "Welcomed") await this.hello(host.host_id, event, now);
    if (
      connection.phase === "Open" &&
      now - attachment.lastSentAt >= (settingsOf(this.env).heartbeatIntervalSeconds * 1000) / 2
    )
      control.beat(context);
    this.keep(socket, attachment);
    if (event.kind !== "Welcomed") return;
    for (const other of this.ctx.getWebSockets()) {
      if (other !== socket) other.close(CloseCode.Replaced, "a newer connection from this host replaced this one");
    }
  }

  private async take(
    hostId: string,
    frame: Frame<HostMessage>,
    attachment: Attachment,
    context: control.ControlContext,
  ): Promise<void> {
    if (this.ledger.queued().length > 0) return this.queue(frame);
    const ordered = frame.message.type !== "TurnLine" && this.ledger.holding();
    if (ordered && !(await this.settle(hostId, attachment, context))) return this.queue(frame);
    const delivered = await this.reply(hostId, frame);
    if (!delivered.ok) return this.queue(frame);
    if (frame.message.type !== "TurnLine") {
      this.checkpoint(attachment, context, [frame]);
      return this.answer(hostId, frame, delivered.reply, attachment, context);
    }
    await this.answer(hostId, frame, delivered.reply, attachment, context);
    this.ledger.hold(frame, true);
  }

  private queue(frame: Frame<HostMessage>): void {
    this.ledger.hold(frame, false);
  }

  private giveUp(attachment: Attachment, context: control.ControlContext): void {
    const first = this.ledger.first();
    this.ledger.take();
    attachment.heldFrom = null;
    control.close(
      context.port,
      CloseCode.ProtocolError,
      `the control plane failed to store frames ${first ?? "none"} onward on ${RETRY_LIMIT} heartbeats in a row; reconnect and resend them`,
    );
  }

  private async heartbeat(
    hostId: string,
    beat: Heartbeat,
    now: number,
    attachment: Attachment,
    context: control.ControlContext,
  ): Promise<boolean> {
    if (!(await this.settle(hostId, attachment, context))) return false;
    if (attachment.connection.phase !== "Open") return false;
    const tenantId = await this.tenantOf(hostId);
    const reported = await tenantApi(this.env.TENANT, tenantId)
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
        heldTurns: beat.heldTurns,
      })
      .then(
        () => true,
        (error: unknown) => this.undelivered("Heartbeat", error),
      );
    if (reported) this.checkpoint(attachment, context, []);
    return reported;
  }

  private checkpoint(attachment: Attachment, context: control.ControlContext, frames: Frame<HostMessage>[]): void {
    const acked = [...this.ledger.take(), ...frames];
    attachment.heldFrom = this.ledger.first();
    if (acked.length > 0) control.acknowledge(context, acked);
  }

  private async settle(hostId: string, attachment: Attachment, context: control.ControlContext): Promise<boolean> {
    for (const frame of this.ledger.queued()) {
      const delivered = await this.reply(hostId, frame);
      if (!delivered.ok) return false;
      this.ledger.forwarded(frame.seq);
      await this.answer(hostId, frame, delivered.reply, attachment, context);
    }
    return true;
  }

  private undelivered(type: string, error: unknown): false {
    console.error(`FrameQueued: ${type} was not stored and waits for the next heartbeat: ${errorOf(error).message}`);
    if (lost(error)) this.ledger.requeue();
    return false;
  }

  private reply(hostId: string, frame: Frame<HostMessage>): Promise<Delivered> {
    return this.forward(hostId, frame.message).then(
      (reply): Delivered => ({ ok: true, reply }),
      (error: unknown): Delivered =>
        resendable(error)
          ? { ok: this.undelivered(frame.message.type, error) }
          : { ok: true, reply: refusedOrResent(frame.message.type, error) },
    );
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

  private keep(socket: WebSocket, attachment: Attachment): void {
    const stored = this.attachment(socket);
    attachment.heldFrom = this.ledger.first();
    attachment.lastSentAt = Math.max(attachment.lastSentAt, stored.lastSentAt);
    socket.serializeAttachment(attachment);
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
      heldTurns: welcomed.heldTurns,
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
    { instruments, samples, turns }: TelemetryBatch,
  ): Promise<void> {
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
      send: (envelope: ControlEnvelope) => {
        socket.send(JSON.stringify(envelope));
        attachment.lastSentAt = Date.now();
      },
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
