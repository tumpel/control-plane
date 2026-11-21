import { DurableObject } from "cloudflare:workers";
import { CloseCode, HostHealthSchema } from "@tumpel/schemas";
import { z } from "zod";
import { errorOf, RETRY_LIMIT } from "./backoff.ts";
import * as control from "./channel/control.ts";
import { lost, refusedOrResent, resendable } from "./channel/failure.ts";
import { HostFrameMeter, type HostHealth, rateLimitDetail } from "./channel/host-health.ts";
import { HostLedger } from "./channel/ledger.ts";
import type {
  ControlEnvelope,
  Frame,
  HostMessage,
  HostReportedHealth,
  HostUsage,
  StoredControlMessage,
  TelemetryBatch,
} from "./channel/protocol.ts";
import { durableDb } from "./db/client.ts";
import * as hostSchema from "./db/host-schema.ts";
import { migrateDurableObject } from "./durable-migrate";
import { HOST_MIGRATIONS } from "./host-migrations.ts";
import { problem } from "./http";
import type { Env } from "./index";
import { limitsOf } from "./limits.ts";
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
  lastReceivedAt: number;
  lastSentAt: number;
  usage: HostUsage | null;
  heldFrom: number | null;
}

type Presence = "Online" | "Offline";

type Delivered = { ok: true; reply: HostReply | null } | { ok: false };

const usageOf = (attachment: Attachment): HostUsage => {
  if (attachment.usage === null)
    throw new Error("a host channel holds transcript lines from a connection that sent no usage");
  return attachment.usage;
};

const isAttachment = (value: unknown): value is Attachment =>
  typeof value === "object" &&
  value !== null &&
  "connection" in value &&
  "lastReceivedAt" in value &&
  typeof value.lastReceivedAt === "number" &&
  "lastSentAt" in value &&
  typeof value.lastSentAt === "number" &&
  "usage" in value &&
  "heldFrom" in value;

export class HostChannel extends DurableObject<Env> {
  private tenantId: string | undefined;
  private inbound: Promise<void> = Promise.resolve();
  private readonly ledger: HostLedger;
  private meter: HostFrameMeter | null = null;
  private tripped: HostHealth | null = null;
  private reported: HostReportedHealth | null = null;

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

  async send(message: StoredControlMessage): Promise<"Sent" | "Deferred"> {
    const host = this.host();
    if (host === null) throw new Error(`a ${message.type} reached a host object that was never registered`);
    if (message.type === "TurnOffer" && (await this.offersPaused(host.host_id))) return "Deferred";
    const open = this.ctx
      .getWebSockets()
      .find(
        (socket) =>
          socket.readyState === WebSocket.READY_STATE_OPEN && this.attachment(socket).connection.phase === "Open",
      );
    if (open === undefined) {
      await control.send({ phase: "Closed" }, message, this.context(null, host, null));
      return "Sent";
    }
    const attachment = this.attachment(open);
    await control.send(attachment.connection, message, this.context(open, host, attachment));
    open.serializeAttachment(attachment);
    return "Sent";
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
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    const attachment: Attachment = {
      connection: { phase: "Closed" },
      lastReceivedAt: now,
      lastSentAt: now,
      usage: null,
      heldFrom: null,
    };
    attachment.connection = control.challenge(this.port(server, attachment));
    server.serializeAttachment(attachment);
    await this.armAlarm(now + this.deadlineMs());
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
      return this.refreshPresence(socket);
    }
    if (attachment.heldFrom !== null && !this.ledger.holding()) {
      control.close(
        context.port,
        CloseCode.ProtocolError,
        `the control plane slept and lost frames ${attachment.heldFrom} onward before it stored them; reconnect and resend them`,
      );
      return this.refreshPresence(socket);
    }
    const now = Date.now();
    attachment.lastReceivedAt = now;
    const meter = await this.frameMeter(host.host_id);
    const { connection, event } = await control.receive(attachment.connection, message, context);
    attachment.connection = connection;
    if (event.kind === "Welcomed") {
      this.ledger.take();
      attachment.usage = event.usage;
    }
    if (event.kind === "Heartbeat" || event.kind === "FirstHeartbeat") attachment.usage = event.usage;
    this.keep(socket, attachment);
    if (this.tripped !== null) await this.trip(host.host_id, this.tripped, meter.framesPerMinute);
    if (event.kind === "Heartbeat" || event.kind === "FirstHeartbeat") {
      await this.reportHealth(host.host_id, event.health);
      if (meter.recovered(now)) {
        await this.setHealth(
          host.host_id,
          "Healthy",
          `host ${host.host_id} sent no more than ${meter.framesPerMinute} frames a minute for a full minute`,
        );
        meter.settle("Healthy");
      }
    }
    if (event.kind === "Message") await this.take(host.host_id, event.frame, now, attachment, context);
    if (event.kind === "FrameRefused") {
      console.error(`FrameRefused: host ${host.host_id} frame ${event.seq}: ${event.reason}`);
    }
    if ((event.kind === "FrameRefused" || event.kind === "FrameRateLimited") && this.ledger.holding())
      await this.flush(host.host_id, usageOf(attachment), now, attachment, context);
    if (event.kind === "Closed") return this.refreshPresence(socket);
    if (event.kind === "FirstHeartbeat") await this.reconcileHeldBoxes(host.host_id, event.heldSessionIds, now);
    if (event.kind === "Heartbeat" || event.kind === "FirstHeartbeat") {
      if (
        !(await this.flush(host.host_id, event.usage, now, attachment, context)) &&
        this.ledger.stalled() >= RETRY_LIMIT
      )
        return this.giveUp(socket, attachment, context);
      await this.sendDeferredOffers(host.host_id, attachment, context);
    }
    if (event.kind === "Welcomed") await this.hello(host.host_id, event, now);
    if (
      connection.phase === "Open" &&
      now - attachment.lastSentAt >= (settingsOf(this.env).heartbeatIntervalSeconds * 1000) / 2
    )
      control.beat(context);
    this.keep(socket, attachment);
    await this.armAlarm(attachment.lastReceivedAt + this.deadlineMs());
    if (event.kind !== "Welcomed") return;
    for (const other of this.ctx.getWebSockets()) {
      if (other !== socket) other.close(CloseCode.Replaced, "a newer connection from this host replaced this one");
    }
    await this.presence("Online");
    await this.sendDeferredOffers(host.host_id, attachment, context);
    this.keep(socket, attachment);
  }

  private async take(
    hostId: string,
    frame: Frame<HostMessage>,
    now: number,
    attachment: Attachment,
    context: control.ControlContext,
  ): Promise<void> {
    const bytes = JSON.stringify(frame.message).length;
    if (this.ledger.queued().length > 0) return this.queue(frame, bytes, attachment, context);
    if (frame.message.type !== "TurnLine" && this.ledger.holding()) {
      if (!(await this.flush(hostId, usageOf(attachment), now, attachment, context)))
        return this.queue(frame, bytes, attachment, context);
    }
    const delivered = await this.reply(hostId, frame);
    if (!delivered.ok) return this.queue(frame, bytes, attachment, context);
    if (frame.message.type !== "TurnLine") {
      control.acknowledge(context, [frame]);
      return this.answer(hostId, frame, delivered.reply, attachment, context);
    }
    await this.answer(hostId, frame, delivered.reply, attachment, context);
    this.ledger.hold(frame, true, bytes);
    if (!this.ledger.full()) return;
    if (!(await this.flush(hostId, usageOf(attachment), now, attachment, context))) this.overflow(attachment, context);
  }

  private queue(
    frame: Frame<HostMessage>,
    bytes: number,
    attachment: Attachment,
    context: control.ControlContext,
  ): void {
    this.ledger.hold(frame, false, bytes);
    if (this.ledger.full()) this.overflow(attachment, context);
  }

  private overflow(attachment: Attachment, context: control.ControlContext): void {
    const first = this.ledger.first();
    this.ledger.take();
    attachment.heldFrom = null;
    control.close(
      context.port,
      CloseCode.ProtocolError,
      `the control plane could not store frames ${first ?? "none"} onward in time; reconnect and resend them`,
    );
  }

  private giveUp(socket: WebSocket, attachment: Attachment, context: control.ControlContext): Promise<void> {
    const first = this.ledger.first();
    this.ledger.take();
    attachment.heldFrom = null;
    control.close(
      context.port,
      CloseCode.ProtocolError,
      `the control plane failed to store frames ${first ?? "none"} onward on ${RETRY_LIMIT} heartbeats in a row; reconnect and resend them`,
    );
    return this.refreshPresence(socket);
  }

  private async flush(
    hostId: string,
    usage: HostUsage,
    now: number,
    attachment: Attachment,
    context: control.ControlContext,
  ): Promise<boolean> {
    for (const frame of this.ledger.queued()) {
      const delivered = await this.reply(hostId, frame);
      if (!delivered.ok) return false;
      this.ledger.forwarded(frame.seq);
      await this.answer(hostId, frame, delivered.reply, attachment, context);
    }
    const reported = await this.report(hostId, usage, now).then(
      () => true,
      (error: unknown) => this.undelivered("Heartbeat", error),
    );
    if (!reported) return false;
    const held = this.ledger.take();
    attachment.heldFrom = this.ledger.first();
    if (held.length > 0) control.acknowledge(context, held);
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
    if (frame.message.type === "SupervisorUpdateFailed") return this.sendDeferredOffers(hostId, attachment, context);
    if (reply === null) return;
    if (reply.type === "TurnHandoff") {
      const sent = await this.env.HOST.get(this.env.HOST.idFromName(reply.hostId)).send(reply.offer);
      if (sent !== "Sent") return;
      const tenantId = await this.tenantOf(hostId);
      await tenantApi(this.env.TENANT, tenantId).call("offerSent", { turnId: reply.offer.turnId });
      return;
    }
    if (reply.type === "Refused") {
      console.error(`FrameRefused: host ${hostId} frame ${frame.seq}: ${reply.reason}`);
      return control.refuseFrame(context.port, frame.seq, reply.reason);
    }
    return control.send(attachment.connection, reply, context);
  }

  private async sendDeferredOffers(
    hostId: string,
    attachment: Attachment,
    context: control.ControlContext,
  ): Promise<void> {
    if (await this.offersPaused(hostId)) return;
    const tenantId = await this.tenantOf(hostId);
    const tenant = tenantApi(this.env.TENANT, tenantId);
    for (const handoff of (await tenant.call("deferredOffers", { tenantId, hostId })).handoffs) {
      const sent =
        handoff.hostId === hostId
          ? await control.send(attachment.connection, handoff.offer, context).then(() => "Sent")
          : await this.env.HOST.get(this.env.HOST.idFromName(handoff.hostId)).send(handoff.offer);
      if (sent === "Sent") await tenant.call("offerSent", { turnId: handoff.offer.turnId });
    }
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
    attachment.heldFrom = this.ledger.first();
    attachment.lastReceivedAt = Math.max(attachment.lastReceivedAt, this.attachment(socket).lastReceivedAt);
    socket.serializeAttachment(attachment);
  }

  private async armAlarm(at: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(at);
  }

  private deadlineMs(): number {
    return settingsOf(this.env).heartbeatDeadlineSeconds * 1000;
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
      hostId,
      boxCapacity: welcomed.boxCapacity,
      usage: welcomed.usage,
      now,
      channelProtocol: welcomed.protocolVersion,
    });
  }

  private async frameMeter(hostId: string): Promise<HostFrameMeter> {
    if (this.meter !== null) return this.meter;
    const row = await this.env.DB.prepare("SELECT health FROM hosts WHERE host_id = ?")
      .bind(hostId)
      .first<{ health: string }>();
    if (row === null) throw new Error(`host ${hostId} has a channel but no row in the hosts table; enrol it again`);
    const sql = this.ctx.storage.sql;
    const [saved] = sql.exec<{ trips: string }>("SELECT trips FROM frame_trips WHERE frame_trips_id = 1").toArray();
    const trips = z.array(z.number()).parse(saved === undefined ? [] : JSON.parse(saved.trips));
    this.meter ??= new HostFrameMeter(
      limitsOf(this.env).hostFramesPerMinute,
      HostHealthSchema.parse(row.health),
      trips,
      {
        save: (next) =>
          sql.exec(
            "INSERT INTO frame_trips (frame_trips_id, trips) VALUES (1, ?) ON CONFLICT (frame_trips_id) DO UPDATE SET trips = excluded.trips",
            JSON.stringify(next),
          ),
        clear: () => sql.exec("DELETE FROM frame_trips WHERE frame_trips_id = 1"),
      },
    );
    return this.meter;
  }

  private async offersPaused(hostId: string): Promise<boolean> {
    return (await this.frameMeter(hostId)).health() !== "Healthy" || this.reported === "RateLimited";
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

  private async reportHealth(hostId: string, health: HostReportedHealth): Promise<void> {
    if (this.reported === health) return;
    this.reported = health;
    await this.env.DB.prepare(
      "UPDATE hosts SET reported_health = ?1, updated_at = ?2 WHERE host_id = ?3 AND reported_health IS NOT ?1",
    )
      .bind(health, Date.now(), hostId)
      .run();
  }

  private async report(hostId: string, usage: HostUsage, now: number): Promise<void> {
    const tenantId = await this.tenantOf(hostId);
    await tenantApi(this.env.TENANT, tenantId).call("hostUsage", { hostId, usage, now });
  }

  private async reconcileHeldBoxes(hostId: string, heldSessionIds: string[], now: number): Promise<void> {
    const tenantId = await this.tenantOf(hostId);
    await tenantApi(this.env.TENANT, tenantId).call("reconcileHeldBoxes", { tenantId, hostId, heldSessionIds, now });
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
      if (message.type === "SupervisorUpdateStep" && message.phase === "Restarting") await this.presence("Offline");
      else await this.refreshPresence();
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
    await tenantApi(this.env.TENANT, tenantId).call("hostPresence", {
      tenantId,
      hostId: host.host_id,
      presence: state,
      now,
    });
  }
}
