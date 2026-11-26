import { ChannelProtocol, CloseCode, StoredHostFrameSchema } from "@tumpel/schemas";
import {
  acked,
  arrival,
  type ControlEnvelope,
  type ControlMessage,
  decodeBase64,
  type Frame,
  type Hello,
  HelloVersionSchema,
  HostEnvelopeSchema,
  type HostMessage,
  type HostReportedHealth,
  heartbeat,
  helloBytes,
  type LedgerStore,
  type MetricBatch,
  type Port,
  type PreparedClaudeSetup,
  type PreparedOffer,
  parseEnvelope,
  type ReportedUsage,
  randomNonce,
  resend,
  type StoredClaudeSetupCode,
  type StoredClaudeSetupOffer,
  type StoredControlMessage,
  type StoredOffer,
  sequence,
} from "./protocol.ts";

export type ControlConnection =
  | { phase: "AwaitingHello"; nonce: string }
  | { phase: "Open"; protocolVersion: number; cursor: number }
  | { phase: "Closed" };

export type OpenConnection = Extract<ControlConnection, { phase: "Open" }>;

export const MAX_HOST_FRAME_BYTES = 4_000_000;

export type MessageVersions = Record<StoredControlMessage["type"], number>;

export const CONTROL_MESSAGE_VERSIONS: MessageVersions = {
  TurnOffer: ChannelProtocol.Oldest,
  TurnWithdrawn: ChannelProtocol.Oldest,
  TurnClaimed: ChannelProtocol.Oldest,
  TurnCancel: ChannelProtocol.Oldest,
  SnapshotRequest: ChannelProtocol.Oldest,
  SnapshotChunksHeld: ChannelProtocol.Oldest,
  SnapshotChunkCheckHeld: 40,
  SnapshotIndexUpload: 40,
  SnapshotNotStored: 42,
  SnapshotPackUploads: ChannelProtocol.Oldest,
  RestoreDownloads: ChannelProtocol.Oldest,
  BoxTeardown: ChannelProtocol.Oldest,
  BoxDiscard: ChannelProtocol.Oldest,
  ClaudeSetupBoxOffer: ChannelProtocol.Oldest,
  ClaudeSetupBoxCode: ChannelProtocol.Oldest,
  ClaudeSetupBoxDiscard: ChannelProtocol.Oldest,
};

export interface ControlHost {
  hostId: string;
  publicKey: string;
  revoked: boolean;
}

export interface ControlContext {
  port: Port<ControlEnvelope>;
  host: ControlHost;
  ledger: LedgerStore<StoredControlMessage>;
  prepareOffer(offer: StoredOffer): Promise<PreparedOffer>;
  prepareClaudeSetup(stored: StoredClaudeSetupOffer | StoredClaudeSetupCode): Promise<PreparedClaudeSetup>;
  messageVersions: MessageVersions;
  admitFrame(): FrameRateRefusal | null;
  now(): Date;
}

export interface FrameRateRefusal {
  reason: string;
  framesPerMinute: number;
  retryAfter: Date;
}

export type ControlEvent =
  | { kind: "None" }
  | {
      kind: "Welcomed";
      boxCapacity: number;
      usage: ReportedUsage;
      supervisorVersion: string;
      protocolVersion: number;
      channelProtocol: number;
      channelProtocolOldest: Hello["channelProtocolOldest"];
      guestProtocol: Hello["guestProtocol"];
      heldTurnIds: string[];
    }
  | {
      kind: "Heartbeat";
      usage: ReportedUsage;
      reportedHealth: HostReportedHealth;
      heldTurnIds: string[];
      heldSessionIds: string[];
      heldClaudeSetupIds: string[];
      telemetry: MetricBatch;
    }
  | { kind: "Message"; frame: Frame<HostMessage> }
  | { kind: "FrameRefused"; seq: number; reason: string }
  | { kind: "FrameRateLimited"; seq: number; reason: string }
  | { kind: "Closed"; code: number; reason: string };

export type Welcomed = Extract<ControlEvent, { kind: "Welcomed" }>;

interface Received {
  connection: ControlConnection;
  event: ControlEvent;
}

const CLOSED: ControlConnection = { phase: "Closed" };

export const close = (port: Port<ControlEnvelope>, code: number, reason: string): Received => {
  port.close(code, reason);
  return { connection: CLOSED, event: { kind: "Closed", code, reason } };
};

export const challenge = (port: Port<ControlEnvelope>): ControlConnection => {
  const nonce = randomNonce();
  port.send({ type: "Challenge", nonce });
  return { phase: "AwaitingHello", nonce };
};

const verifies = async (publicKey: string, signature: string, bytes: Uint8Array<ArrayBuffer>): Promise<boolean> => {
  const key = decodeBase64(publicKey);
  const signed = decodeBase64(signature);
  if (key === null || signed === null || key.byteLength !== 32 || signed.byteLength !== 64) return false;
  const imported = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, imported, signed, bytes);
};

export const prepare = async (stored: StoredControlMessage, context: ControlContext): Promise<ControlMessage> => {
  if (stored.type === "ClaudeSetupBoxOffer" || stored.type === "ClaudeSetupBoxCode") {
    return (await context.prepareClaudeSetup(stored)).message;
  }
  if (stored.type !== "TurnOffer") return stored;
  const prepared = await context.prepareOffer(stored);
  if (prepared.kind === "Withdrawn") return { type: "TurnWithdrawn", turnId: stored.turnId };
  const { credential, lastLineSeq, snapshots, personaFiles, image, gitAuthorName, gitAuthorEmail } = prepared;
  return {
    ...stored,
    credential,
    lastLineSeq,
    snapshots,
    personaFiles,
    image,
    gitAuthorName,
    gitAuthorEmail,
  };
};

const unspoken = (
  protocolVersion: number,
  type: StoredControlMessage["type"],
  seq: number,
  context: ControlContext,
): Received | null => {
  const needed = context.messageVersions[type];
  if (needed <= protocolVersion) return null;
  return close(
    context.port,
    CloseCode.UnsupportedVersion,
    `frame ${seq} carries ${type}, which needs protocol version ${needed}; this connection speaks ${protocolVersion}, update the supervisor`,
  );
};

const store = (
  message: StoredControlMessage,
  connection: ControlConnection,
  context: ControlContext,
): Frame<StoredControlMessage> => {
  const { ledger, frame } = sequence(
    context.ledger.load(),
    message,
    connection.phase === "Open" ? connection.cursor : 0,
  );
  context.ledger.save(ledger);
  return frame;
};

const dropAcked = (context: ControlContext, ack: number): void => {
  const ledger = context.ledger.load();
  const kept = acked(ledger, ack);
  if (kept.unacked.length !== ledger.unacked.length) context.ledger.save(kept);
};

const sending = new WeakMap<LedgerStore<StoredControlMessage>, Promise<void>>();

const inSeqOrder = (context: ControlContext, task: () => Promise<void>): Promise<void> => {
  const turn = (sending.get(context.ledger) ?? Promise.resolve()).then(task);
  sending.set(
    context.ledger,
    turn.then(
      () => undefined,
      () => undefined,
    ),
  );
  return turn;
};

export const send = async (
  connection: ControlConnection,
  message: StoredControlMessage,
  context: ControlContext,
  prepared?: ControlMessage,
): Promise<void> => {
  const frame = store(message, connection, context);
  if (connection.phase !== "Open") return;
  if (unspoken(connection.protocolVersion, message.type, frame.seq, context) !== null) return;
  return inSeqOrder(context, async () => {
    const spoken = prepared ?? (await prepare(message, context));
    context.port.send({ ...frame, message: spoken });
  });
};

export const refuseFrame = (port: Port<ControlEnvelope>, seq: number, reason: string): void =>
  port.send({ type: "FrameRefused", seq, reason });

const refuseOverRate = (
  port: Port<ControlEnvelope>,
  seq: number,
  { reason, framesPerMinute, retryAfter }: FrameRateRefusal,
): void => {
  port.send({ type: "FrameRateLimited", seq, reason, framesPerMinute, retryAfter: retryAfter.toISOString() });
};

export const revoke = (context: ControlContext, reason: string): Received =>
  close(context.port, CloseCode.Revoked, `host ${context.host.hostId} is revoked: ${reason}`);

const hello = async (
  connection: { phase: "AwaitingHello"; nonce: string },
  envelope: Hello,
  channelProtocol: number,
  context: ControlContext,
): Promise<Received> => {
  const signed = helloBytes(connection.nonce, envelope.hostId);
  if (
    envelope.hostId !== context.host.hostId ||
    !(await verifies(context.host.publicKey, envelope.signature, signed))
  ) {
    return close(
      context.port,
      CloseCode.BadSignature,
      `the Hello signature does not verify against the key host ${envelope.hostId} enrolled with; enrol the host again`,
    );
  }
  if (context.host.revoked) return revoke(context, "the tenant revoked this host");
  const ledger = context.ledger.load();
  for (const frame of ledger.unacked) {
    const refused = unspoken(channelProtocol, frame.message.type, frame.seq, context);
    if (refused !== null) return refused;
  }
  const cursor = envelope.resendFrom - 1;
  const resent = await resend(ledger, cursor, (stored) => prepare(stored, context));
  context.port.send({ type: "Welcome", hostId: context.host.hostId, protocolVersion: channelProtocol });
  for (const frame of resent) context.port.send(frame);
  return {
    connection: { phase: "Open", protocolVersion: channelProtocol, cursor },
    event: {
      kind: "Welcomed",
      boxCapacity: envelope.boxCapacity,
      usage: envelope.usage,
      supervisorVersion: envelope.supervisorVersion,
      protocolVersion: envelope.protocolVersion,
      channelProtocol,
      channelProtocolOldest: envelope.channelProtocolOldest,
      guestProtocol: envelope.guestProtocol,
      heldTurnIds: envelope.heldTurnIds,
    },
  };
};

const helloVersion = (connection: ControlConnection, text: string, context: ControlContext): number | Received => {
  if (connection.phase === "Open") return connection.protocolVersion;
  const greeting = parseEnvelope(HelloVersionSchema, text);
  if (!greeting.ok) return ChannelProtocol.Version;
  const { protocolVersion, channelProtocolOldest } = greeting.value;
  const oldest = channelProtocolOldest ?? protocolVersion;
  const negotiated = Math.min(protocolVersion, ChannelProtocol.Version);
  if (negotiated >= Math.max(oldest, ChannelProtocol.Oldest)) return negotiated;
  return close(
    context.port,
    CloseCode.UnsupportedVersion,
    `${oldest === protocolVersion ? `protocol version ${protocolVersion} is` : `protocol versions ${oldest} to ${protocolVersion} are`} not supported; this control plane speaks ${ChannelProtocol.Oldest} to ${ChannelProtocol.Version}, update the supervisor`,
  );
};

const gap = (context: ControlContext, expected: number, got: number): Received =>
  close(context.port, CloseCode.ProtocolError, `frame gap: expected seq ${expected}, got ${got}`);

const duplicate = (connection: OpenConnection, seq: number, context: ControlContext): Received => {
  context.port.send({ type: "Ack", seq });
  return { connection, event: { kind: "None" } };
};

const refuse = (connection: OpenConnection, text: string, reason: string, context: ControlContext): Received => {
  const stored = parseEnvelope(StoredHostFrameSchema, text);
  if (!stored.ok) return close(context.port, CloseCode.ProtocolError, reason);
  const { seq } = stored.value;
  const arrived = arrival(connection.cursor, seq);
  if (arrived.kind === "Duplicate") return duplicate(connection, seq, context);
  if (arrived.kind === "Gap") return gap(context, arrived.expected, arrived.got);
  refuseFrame(context.port, seq, reason);
  return { connection: { ...connection, cursor: seq }, event: { kind: "FrameRefused", seq, reason } };
};

export const receive = async (
  connection: ControlConnection,
  text: string,
  context: ControlContext,
): Promise<Received> => {
  if (connection.phase === "Closed") return { connection, event: { kind: "None" } };
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_HOST_FRAME_BYTES) {
    const reason = `a host frame of ${bytes} bytes is over the ${MAX_HOST_FRAME_BYTES}-byte bound the control plane stores; split the message or shorten its text`;
    if (connection.phase === "Open") return refuse(connection, text, reason, context);
    return close(context.port, CloseCode.ProtocolError, reason);
  }
  const version = helloVersion(connection, text, context);
  if (typeof version !== "number") return version;
  const parsed = parseEnvelope(HostEnvelopeSchema, text);
  if (!parsed.ok && connection.phase === "Open") return refuse(connection, text, parsed.reason, context);
  if (!parsed.ok) return close(context.port, CloseCode.ProtocolError, parsed.reason);
  const envelope = parsed.value;
  if (connection.phase === "AwaitingHello") {
    if (envelope.type !== "Hello") {
      return close(context.port, CloseCode.ProtocolError, `expected Hello after Challenge, got ${envelope.type}`);
    }
    return hello(connection, envelope, version, context);
  }
  if (envelope.type === "Hello") {
    return close(context.port, CloseCode.ProtocolError, "Hello arrived twice on one connection");
  }
  if (envelope.type === "Heartbeat") {
    dropAcked(context, envelope.ack);
    return {
      connection,
      event: {
        kind: "Heartbeat",
        usage: envelope.usage,
        reportedHealth: envelope.health ?? "Healthy",
        heldTurnIds: envelope.heldTurnIds,
        heldSessionIds: envelope.heldSessionIds,
        heldClaudeSetupIds: envelope.heldClaudeSetupIds,
        telemetry: envelope.telemetry,
      },
    };
  }
  const { message } = envelope;
  const arrived = arrival(connection.cursor, envelope.seq);
  if (arrived.kind === "Duplicate") return duplicate(connection, envelope.seq, context);
  const overRate = context.admitFrame();
  if (overRate !== null) {
    refuseOverRate(context.port, envelope.seq, overRate);
    return { connection, event: { kind: "FrameRateLimited", seq: envelope.seq, reason: overRate.reason } };
  }
  if (arrived.kind === "Gap") return gap(context, arrived.expected, arrived.got);
  return {
    connection,
    event: {
      kind: "Message",
      frame: { type: "Frame", seq: envelope.seq, ack: envelope.ack, message },
    },
  };
};

export const acknowledge = (connection: OpenConnection, seq: number, context: ControlContext): OpenConnection => {
  context.port.send({ type: "Ack", seq });
  return { ...connection, cursor: seq };
};

export const beat = (context: ControlContext): void => context.port.send(heartbeat(context.now()));
