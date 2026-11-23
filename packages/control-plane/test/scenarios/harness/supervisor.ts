import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { ChannelProtocol, type HostUsageSchema, StoredTurnOfferSchema } from "@tumpel/schemas";
import type { WebSocket } from "ws";
import { z } from "zod";
import { ControlEnvelopeSchema, HELD_TURNS_PROTOCOL, helloBytes } from "../../../src/channel/protocol.ts";
import { openSocket } from "./server.ts";

const REPLIES = new Set([
  "SnapshotChunksHeld",
  "SnapshotPackUploads",
  "RestoreDownloads",
  "TurnClaimed",
  "BoxDiscard",
  "ClaudeSetupBoxDiscard",
]);

export const GIVE_UP_MS = 60_000;
const STEP_MS = 50;

export type Clock = {
  settle(): Promise<void>;
  tick(ms: number): Promise<void>;
};

export type HostUsage = z.infer<typeof HostUsageSchema>;
type ControlEnvelope = z.infer<typeof ControlEnvelopeSchema>;
export type ControlMessage = Extract<ControlEnvelope, { type: "Frame" }>["message"];
export type HostMessage = { type: string } & Record<string, unknown>;
export type TurnOffer = z.infer<typeof StoredTurnOfferSchema>;
export type Carried = { received: number; sent: number; held: string[]; turns: string[] };
export type Holding = { heldTurnIds: string[]; heldSessionIds: string[]; heldClaudeSetupIds: string[] };
type SentFrame = { type: "Frame"; seq: number; ack: number; message: HostMessage };
export type Closed = { code: number; reason: string; wasClean: boolean };

export const DEFAULT_USAGE: HostUsage = {
  boxesWarm: 0,
  loadAverage: 0,
  memoryAvailableMib: 30000,
  memoryBudgetMib: 30000,
  memoryHeldMib: 0,
  diskBudgetMib: 1_000_000,
  diskHeldMib: 0,
};

export const until = async <T>(
  clock: Clock,
  what: string,
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
): Promise<T> => {
  const deadline = Date.now() + GIVE_UP_MS;
  for (;;) {
    await clock.settle();
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) {
      assert.fail(`gave up after ${GIVE_UP_MS} ms waiting for ${what}; last read ${JSON.stringify(value)}`);
    }
    await clock.tick(STEP_MS);
  }
};

export const hostKey = (): { privateKey: KeyObject; publicKey: string } => {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x ?? "", "base64url").toString("base64");
  return { privateKey: pair.privateKey, publicKey };
};

export type SupervisorOptions = {
  boxCapacity: number;
  protocolVersion: number;
  carried: Carried;
  resend: HostMessage[];
  usage: HostUsage;
  heartbeatMs: number;
  supervisorVersion: string;
  unacked: SentFrame[];
  store: { put(key: string, body: string): Promise<unknown> };
};

const RESULT = '{"type":"result","subtype":"success","is_error":false}';

export class Supervisor {
  readonly hostId: string;
  private readonly clock: Clock;
  private readonly origin: string;
  private readonly key: KeyObject;
  private readonly options: SupervisorOptions;
  private heard: number;
  private sent: number;
  private acked = 0;
  private readonly held: Set<string>;
  private readonly turns: Set<string>;
  private readonly released = new Set<string>();
  private unacked: SentFrame[];
  private usage: HostUsage;
  private welcomed = false;
  private challenged = false;
  private readonly inbox: ControlMessage[] = [];
  private readonly refusals: { seq: number; reason: string }[] = [];
  private readonly limited: number[] = [];
  private readonly lineSeqs = new Map<string, number>();
  private closedWith: Closed | null = null;
  private broken: Error | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly socket: WebSocket;

  private constructor(clock: Clock, origin: string, hostId: string, key: KeyObject, options: SupervisorOptions) {
    this.clock = clock;
    this.origin = origin;
    this.hostId = hostId;
    this.key = key;
    this.options = options;
    this.usage = options.usage;
    this.heard = options.carried.received;
    this.sent = options.carried.sent;
    this.held = new Set(options.carried.held);
    this.turns = new Set(options.carried.turns);
    this.unacked = [...options.unacked];
    this.socket = openSocket(`${origin.replace(/^http/, "ws")}/v1/hosts/${hostId}/channel`);
    this.socket.on("message", (data) => this.receive(String(data)));
    this.socket.on("error", () => undefined);
    this.socket.on("close", (code, reason) => {
      this.closedWith = { code, reason: reason.toString(), wasClean: code !== 1006 };
      this.quiet();
    });
    this.heartbeat = setInterval(() => this.beat(), options.heartbeatMs);
  }

  static async connect(
    clock: Clock,
    origin: string,
    hostId: string,
    key: KeyObject,
    options: Partial<SupervisorOptions> & Pick<SupervisorOptions, "heartbeatMs" | "store">,
  ): Promise<Supervisor> {
    const side = new Supervisor(clock, origin, hostId, key, {
      boxCapacity: 8,
      protocolVersion: ChannelProtocol.Version,
      carried: { received: 0, sent: 0, held: [], turns: [] },
      resend: [],
      usage: DEFAULT_USAGE,
      supervisorVersion: "0.1.0",
      unacked: [],
      ...options,
    });
    await until(
      clock,
      `the Challenge of host ${hostId}`,
      () => side.challenged || side.closedWith !== null,
      (done) => done,
    );
    return side;
  }

  async reconnect(options: Partial<SupervisorOptions> = {}): Promise<Supervisor> {
    this.quiet();
    const side = await Supervisor.connect(this.clock, this.origin, this.hostId, this.key, {
      ...this.options,
      usage: this.usage,
      carried: this.carried(),
      unacked: this.unacked,
      resend: [],
      ...options,
    });
    side.inbox.unshift(...this.inbox.splice(0));
    return side;
  }

  private beat(): void {
    if (!this.welcomed || this.closedWith !== null) return;
    this.heartbeatWith(this.holding());
  }

  private heartbeatWith(holding: Holding): void {
    this.raw({
      type: "Heartbeat",
      sentAt: new Date().toISOString(),
      usage: this.usage,
      heldSessionIds: holding.heldSessionIds,
      heldClaudeSetupIds: holding.heldClaudeSetupIds,
      ...this.heldTurnIds(holding.heldTurnIds),
    });
  }

  private heldTurnIds(heldTurnIds: string[]): { heldTurnIds?: string[] } {
    return this.options.protocolVersion >= HELD_TURNS_PROTOCOL ? { heldTurnIds } : {};
  }

  holding(): Holding {
    return {
      heldTurnIds: [...this.turns],
      heldSessionIds: [...this.held].filter((id) => !this.released.has(id)),
      heldClaudeSetupIds: [],
    };
  }

  async beats(holding: Partial<Holding> = {}): Promise<void> {
    this.heartbeatWith({ ...this.holding(), ...holding });
    await this.clock.settle();
    this.assertOpen("after a Heartbeat");
  }

  quiet(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  resumes(): void {
    this.quiet();
    this.heartbeat = setInterval(() => this.beat(), this.options.heartbeatMs);
    this.beat();
  }

  report(usage: HostUsage): void {
    this.usage = { ...this.usage, ...usage };
    this.beat();
  }

  raw(envelope: unknown): void {
    this.socket.send(JSON.stringify(envelope));
  }

  private receive(text: string): void {
    try {
      this.accept(ControlEnvelopeSchema.parse(JSON.parse(text)));
    } catch (error) {
      this.broken ??= error instanceof Error ? error : new Error(String(error));
    }
  }

  private accept(envelope: ControlEnvelope): void {
    if ("ack" in envelope && typeof envelope.ack === "number") this.acknowledged(envelope.ack);
    if (envelope.type === "Challenge") {
      this.challenged = true;
      this.raw({
        type: "Hello",
        hostId: this.hostId,
        protocolVersion: this.options.protocolVersion,
        supervisorVersion: this.options.supervisorVersion,
        signature: sign(null, helloBytes(envelope.nonce, this.hostId), this.key).toString("base64"),
        boxCapacity: this.options.boxCapacity,
        usage: this.usage,
        ...this.heldTurnIds([...this.turns]),
      });
      return;
    }
    if (envelope.type === "Welcome") {
      this.welcomed = true;
      for (const frame of this.unacked) this.raw({ ...frame, ack: this.heard });
      for (const message of this.options.resend) this.send(message);
      return;
    }
    if (envelope.type === "FrameRateLimited") {
      this.limited.push(envelope.seq);
      return;
    }
    if (envelope.type === "FrameRefused") {
      this.refusals.push({ seq: envelope.seq, reason: envelope.reason });
      return;
    }
    if (envelope.type !== "Frame" || envelope.seq <= this.heard) return;
    assert.equal(envelope.seq, this.heard + 1, "the control plane skipped a frame");
    this.heard = envelope.seq;
    if (envelope.message.type === "TurnOffer") {
      this.held.add(envelope.message.sessionId);
      this.released.delete(envelope.message.sessionId);
      this.turns.add(envelope.message.turnId);
    }
    if (envelope.message.type === "BoxDiscard") this.released.add(envelope.message.sessionId);
    this.inbox.push(envelope.message);
  }

  private acknowledged(ack: number): void {
    this.acked = Math.max(this.acked, ack);
    this.unacked = this.unacked.filter((frame) => frame.seq > this.acked);
  }

  send(message: HostMessage): number {
    if ((message.type === "TurnComplete" || message.type === "TurnFailed") && typeof message.turnId === "string")
      this.turns.delete(message.turnId);
    if (message.type === "BoxGone" && typeof message.sessionId === "string") this.released.add(message.sessionId);
    this.sent += 1;
    const frame: SentFrame = { type: "Frame", seq: this.sent, ack: this.heard, message };
    this.unacked.push(frame);
    this.raw(frame);
    return frame.seq;
  }

  async says(message: HostMessage): Promise<{ reply?: ControlMessage }> {
    const before = this.inbox.length;
    const seq = this.send(message);
    await this.clock.settle();
    this.assertOpen(`after host ${this.hostId} sent ${message.type}`);
    if (this.limited.includes(seq)) throw new Error(`the control plane rate limited ${message.type} at seq ${seq}`);
    const refused = this.refusals.findIndex((refusal) => refusal.seq === seq);
    if (refused !== -1) {
      const [refusal] = this.refusals.splice(refused, 1);
      throw new Error(`the control plane refused ${message.type}: ${refusal?.reason}`);
    }
    const answered = this.inbox.findIndex((sent, at) => at >= before && REPLIES.has(sent.type));
    if (answered === -1) return {};
    const [reply] = this.inbox.splice(answered, 1);
    return { reply };
  }

  async next<K extends ControlMessage["type"]>(type: K): Promise<Extract<ControlMessage, { type: K }>> {
    const found = await until(
      this.clock,
      `a ${type} to reach host ${this.hostId}`,
      () => {
        this.assertOpen(`waiting for ${type}`);
        return this.inbox.findIndex((message) => message.type === type);
      },
      (at) => at !== -1,
    );
    return this.inbox.splice(found, 1)[0] as Extract<ControlMessage, { type: K }>;
  }

  async refusal(): Promise<{ seq: number; reason: string }> {
    await until(
      this.clock,
      `a FrameRefused to reach host ${this.hostId}`,
      () => {
        this.assertOpen("waiting for FrameRefused");
        return this.refusals.length;
      },
      (count) => count > 0,
    );
    const [refused] = this.refusals.splice(0, 1);
    if (refused === undefined) throw new Error("the refusal vanished");
    return refused;
  }

  async closed(): Promise<Closed> {
    const closed = await until(
      this.clock,
      `the channel of host ${this.hostId} to close`,
      () => this.closedWith,
      (value) => value !== null,
    );
    if (closed === null) throw new Error("the close vanished");
    return closed;
  }

  closure(): Closed | null {
    return this.closedWith;
  }

  isWelcomed(): boolean {
    return this.welcomed;
  }

  assertOpen(when: string): void {
    if (this.broken !== null) throw this.broken;
    if (this.closedWith === null) return;
    const { code, reason, wasClean } = this.closedWith;
    assert.fail(
      `the control plane closed the channel ${wasClean ? "cleanly" : "without a close frame"} with ${code} ${reason} ${when}`,
    );
  }

  holds(type: ControlMessage["type"]): boolean {
    return this.inbox.some((message) => message.type === type);
  }

  received(type: string): ControlMessage[] {
    return this.inbox.filter((message) => message.type === type);
  }

  take(type: string): ControlMessage {
    if (this.broken !== null) throw this.broken;
    const at = this.inbox.findIndex((message) => message.type === type);
    if (at === -1) {
      throw new Error(
        `host ${this.hostId} was sent no ${type}; it holds ${JSON.stringify(this.inbox.map((message) => message.type))}`,
      );
    }
    const [message] = this.inbox.splice(at, 1);
    if (message === undefined) throw new Error("the message vanished");
    return message;
  }

  takeOffer(): TurnOffer {
    return StoredTurnOfferSchema.parse(this.take("TurnOffer"));
  }

  rateLimited(): number[] {
    return [...this.limited];
  }

  acknowledgedSeq(): number {
    return this.acked;
  }

  unackedSeqs(): number[] {
    return this.unacked.map((frame) => frame.seq);
  }

  carried(): Carried {
    return { received: this.heard, sent: this.sent, held: [...this.held], turns: [...this.turns] };
  }

  close(): void {
    this.quiet();
    if (this.closedWith === null) this.socket.close();
  }

  async closesSocket(): Promise<void> {
    this.close();
    await this.clock.settle();
  }

  async claims(offer: TurnOffer): Promise<void> {
    await this.says({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
  }

  async finishes(offer: TurnOffer): Promise<void> {
    await this.completes(offer);
    await this.answersSnapshot(offer.sessionId);
  }

  async completes(offer: TurnOffer): Promise<void> {
    const lineSeq = (this.lineSeqs.get(offer.sessionId) ?? 0) + 1;
    this.lineSeqs.set(offer.sessionId, lineSeq);
    await this.says({ type: "TurnLine", turnId: offer.turnId, lineSeq, text: RESULT });
    await this.says({
      type: "TurnComplete",
      turnId: offer.turnId,
      lastLineSeq: lineSeq,
      completedAt: new Date(Date.now()).toISOString(),
    });
  }

  async answersSnapshot(sessionId: string): Promise<void> {
    const store = this.options.store;
    const request = z
      .object({ snapshotId: z.string(), sessionId: z.string(), storageKey: z.string() })
      .parse(this.take("SnapshotRequest"));
    if (request.sessionId !== sessionId) throw new Error(`the snapshot asked for is of ${request.sessionId}`);
    const manifest = JSON.stringify({ entries: [] });
    const digest = createHash("sha256").update(manifest).digest("hex");
    await this.says({
      type: "SnapshotPacks",
      snapshotId: request.snapshotId,
      part: 1,
      packs: [{ packDigest: digest, sizeBytes: manifest.length }],
      chunks: [{ digest, packDigest: digest, offset: 0, length: manifest.length }],
    });
    await store.put(`${request.storageKey.split("/")[0]}/packs/${digest}`, manifest);
    await store.put(
      request.storageKey,
      JSON.stringify({ manifest: [{ digest, packDigest: digest, offset: 0, length: manifest.length }] }),
    );
    await this.says({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: manifest.length });
  }

  async dropsIdleBox(offer: TurnOffer): Promise<void> {
    await this.says({ type: "BoxGone", sessionId: offer.sessionId, boxId: offer.boxId });
  }
}
