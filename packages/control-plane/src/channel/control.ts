import { ChannelProtocol, CloseCode, StoredHostFrameSchema } from "@tumpel/schemas";
import {
  accept,
  type ControlEnvelope,
  type ControlMessage,
  type DispatchGrant,
  decodeBase64,
  type Frame,
  HELD_SESSIONS_VERSION,
  type Hello,
  HelloVersionSchema,
  HostEnvelopeBeforeHeldSessionsSchema,
  HostEnvelopeSchema,
  type HostMessage,
  type HostUsage,
  heartbeat,
  helloBytes,
  type LedgerStore,
  type Port,
  type PreparedClaudeSetup,
  type PreparedOffer,
  parseEnvelope,
  randomNonce,
  reportsHeldSessions,
  resend,
  type StoredClaudeSetupCode,
  type StoredClaudeSetupOffer,
  type StoredControlMessage,
  type StoredOffer,
  sequence,
} from "./protocol.ts";

export type ControlConnection =
  | { phase: "AwaitingHello"; nonce: string }
  | { phase: "Open"; protocolVersion: number; heldReported: boolean }
  | { phase: "Closed" };

export const TURN_CANCEL_VERSION = 23;
export const MAX_HOST_FRAME_BYTES = 4_000_000;

export type MessageVersions = Record<StoredControlMessage["type"], number>;

export const CONTROL_MESSAGE_VERSIONS: MessageVersions = {
  TurnOffer: ChannelProtocol.Oldest,
  TurnWithdrawn: ChannelProtocol.Oldest,
  TurnClaimed: ChannelProtocol.Oldest,
  TurnCancel: TURN_CANCEL_VERSION,
  SnapshotRequest: ChannelProtocol.Oldest,
  SnapshotChunksHeld: ChannelProtocol.Oldest,
  SnapshotPackUploads: ChannelProtocol.Oldest,
  RestoreDownloads: ChannelProtocol.Oldest,
  BoxTeardown: ChannelProtocol.Oldest,
  BoxDiscard: ChannelProtocol.Oldest,
  ClaudeSetupBoxOffer: ChannelProtocol.Oldest,
  ClaudeSetupBoxCode: ChannelProtocol.Oldest,
  ClaudeSetupBoxDiscard: ChannelProtocol.Oldest,
};

export type HostMessageVersions = Record<HostMessage["type"], number>;

export const TELEMETRY_BATCH_VERSION = 19;

export const HOST_MESSAGE_VERSIONS: HostMessageVersions = {
  TurnImageFetching: ChannelProtocol.Oldest,
  TurnClaim: ChannelProtocol.Oldest,
  TurnRepositoryReady: ChannelProtocol.Oldest,
  TurnLine: ChannelProtocol.Oldest,
  TurnComplete: ChannelProtocol.Oldest,
  TurnRepositoryCloneFailed: ChannelProtocol.Oldest,
  TurnFailed: ChannelProtocol.Oldest,
  SnapshotChunks: ChannelProtocol.Oldest,
  SnapshotPacks: ChannelProtocol.Oldest,
  RestoreChunks: ChannelProtocol.Oldest,
  SnapshotDone: ChannelProtocol.Oldest,
  SnapshotFailed: ChannelProtocol.Oldest,
  BoxGone: ChannelProtocol.Oldest,
  BoxTeardownFailed: ChannelProtocol.Oldest,
  ClaudeSetupBoxUrl: ChannelProtocol.Oldest,
  ClaudeSetupBoxFailed: ChannelProtocol.Oldest,
  SupervisorUpdateStep: ChannelProtocol.Oldest,
  SupervisorUpdateFailed: ChannelProtocol.Oldest,
  TelemetryBatch: TELEMETRY_BATCH_VERSION,
};

export const CONNECTORS_VERSION = 26;

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
  now(): Date;
}

export type ControlEvent =
  | { kind: "None" }
  | {
      kind: "Welcomed";
      boxCapacity: number;
      usage: HostUsage;
      supervisorVersion: string;
      protocolVersion: number;
      channelProtocolOldest: Hello["channelProtocolOldest"];
      guestProtocol: Hello["guestProtocol"];
    }
  | { kind: "Heartbeat"; usage: HostUsage }
  | { kind: "FirstHeartbeat"; usage: HostUsage; heldSessionIds: string[] }
  | { kind: "Message"; frame: Frame<HostMessage> }
  | { kind: "FrameRefused"; seq: number; reason: string }
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

const spokenGrant = (credential: DispatchGrant, protocolVersion: number): DispatchGrant =>
  protocolVersion >= CONNECTORS_VERSION ? credential : { ...credential, connectors: [] };

const outbound = async (
  stored: StoredControlMessage,
  protocolVersion: number,
  context: ControlContext,
): Promise<ControlMessage> => {
  if (stored.type === "ClaudeSetupBoxOffer" || stored.type === "ClaudeSetupBoxCode") {
    return (await context.prepareClaudeSetup(stored)).message;
  }
  if (stored.type !== "TurnOffer") return stored;
  const prepared = await context.prepareOffer(stored);
  if (prepared.kind === "Withdrawn") return { type: "TurnWithdrawn", turnId: stored.turnId };
  const { credential, lastLineSeq, snapshots, personaFiles, image, gitAuthorName, gitAuthorEmail } = prepared;
  return {
    ...stored,
    credential: spokenGrant(credential, protocolVersion),
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

const store = (message: StoredControlMessage, context: ControlContext): Frame<StoredControlMessage> => {
  const { ledger, frame } = sequence(context.ledger.load(), message);
  context.ledger.save(ledger);
  return frame;
};

export const send = async (
  connection: ControlConnection,
  message: StoredControlMessage,
  context: ControlContext,
): Promise<void> => {
  if (connection.phase !== "Open") {
    store(message, context);
    return;
  }
  const { protocolVersion } = connection;
  const nextSeq = context.ledger.load().sent + 1;
  if (unspoken(protocolVersion, message.type, nextSeq, context) !== null) {
    store(message, context);
    return;
  }
  const spoken = await outbound(message, protocolVersion, context);
  context.port.send({ ...store(message, context), message: spoken });
};

export const refuseFrame = (port: Port<ControlEnvelope>, seq: number, reason: string): void =>
  port.send({ type: "FrameRefused", seq, reason });

export const revoke = (context: ControlContext, reason: string): Received =>
  close(context.port, CloseCode.Revoked, `host ${context.host.hostId} is revoked: ${reason}`);

const hello = async (
  connection: { phase: "AwaitingHello"; nonce: string },
  envelope: Hello,
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
    const refused = unspoken(envelope.protocolVersion, frame.message.type, frame.seq, context);
    if (refused !== null) return refused;
  }
  const resent = await resend(ledger, (stored) => outbound(stored, envelope.protocolVersion, context));
  context.port.send({
    type: "Welcome",
    hostId: context.host.hostId,
    protocolVersion: envelope.protocolVersion,
    ack: ledger.received,
  });
  for (const frame of resent) context.port.send(frame);
  return {
    connection: { phase: "Open", protocolVersion: envelope.protocolVersion, heldReported: false },
    event: {
      kind: "Welcomed",
      boxCapacity: envelope.boxCapacity,
      usage: envelope.usage,
      supervisorVersion: envelope.supervisorVersion,
      protocolVersion: envelope.protocolVersion,
      channelProtocolOldest: envelope.channelProtocolOldest,
      guestProtocol: envelope.guestProtocol,
    },
  };
};

const spoken = (version: number): boolean => version >= ChannelProtocol.Oldest && version <= ChannelProtocol.Version;

const refuse = async (
  connection: ControlConnection,
  text: string,
  reason: string,
  context: ControlContext,
): Promise<Received> => {
  const stored = parseEnvelope(StoredHostFrameSchema, text);
  if (!stored.ok) return close(context.port, CloseCode.ProtocolError, reason);
  const outcome = accept(context.ledger.load(), stored.value);
  if (outcome.kind === "Duplicate") return { connection, event: { kind: "None" } };
  if (outcome.kind === "Gap") {
    return close(
      context.port,
      CloseCode.ProtocolError,
      `frame gap: expected seq ${outcome.expected}, got ${outcome.got}`,
    );
  }
  context.ledger.save(outcome.ledger);
  refuseFrame(context.port, stored.value.seq, reason);
  return { connection, event: { kind: "FrameRefused", seq: stored.value.seq, reason } };
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
  if (connection.phase === "AwaitingHello") {
    const greeting = parseEnvelope(HelloVersionSchema, text);
    if (greeting.ok && !spoken(greeting.value.protocolVersion)) {
      return close(
        context.port,
        CloseCode.UnsupportedVersion,
        `protocol version ${greeting.value.protocolVersion} is not supported; this control plane speaks ${ChannelProtocol.Oldest} to ${ChannelProtocol.Version}, update the supervisor`,
      );
    }
  }
  const parsed =
    connection.phase === "Open" && connection.protocolVersion < HELD_SESSIONS_VERSION
      ? parseEnvelope(HostEnvelopeBeforeHeldSessionsSchema, text)
      : parseEnvelope(HostEnvelopeSchema, text);
  if (!parsed.ok && connection.phase === "Open") return refuse(connection, text, parsed.reason, context);
  if (!parsed.ok) return close(context.port, CloseCode.ProtocolError, parsed.reason);
  const envelope = parsed.value;
  if (connection.phase === "AwaitingHello") {
    if (envelope.type !== "Hello") {
      return close(context.port, CloseCode.ProtocolError, `expected Hello after Challenge, got ${envelope.type}`);
    }
    return hello(connection, envelope, context);
  }
  if (envelope.type === "Hello") {
    return close(context.port, CloseCode.ProtocolError, "Hello arrived twice on one connection");
  }
  if (envelope.type === "Heartbeat") {
    if (connection.heldReported || !reportsHeldSessions(envelope)) {
      return { connection, event: { kind: "Heartbeat", usage: envelope.usage } };
    }
    return {
      connection: { ...connection, heldReported: true },
      event: { kind: "FirstHeartbeat", usage: envelope.usage, heldSessionIds: envelope.heldSessionIds },
    };
  }
  const needed = HOST_MESSAGE_VERSIONS[envelope.message.type];
  if (needed > connection.protocolVersion) {
    return refuse(
      connection,
      text,
      `frame ${envelope.seq} carries ${envelope.message.type}, which needs protocol version ${needed}; this connection speaks ${connection.protocolVersion}, update the supervisor`,
      context,
    );
  }
  const outcome = accept(context.ledger.load(), envelope);
  if (outcome.kind === "Duplicate") return { connection, event: { kind: "None" } };
  if (outcome.kind === "Gap") {
    return close(
      context.port,
      CloseCode.ProtocolError,
      `frame gap: expected seq ${outcome.expected}, got ${outcome.got}`,
    );
  }
  return {
    connection,
    event: {
      kind: "Message",
      frame: { type: "Frame", seq: envelope.seq, ack: envelope.ack, message: outcome.message },
    },
  };
};

export const acknowledge = (context: ControlContext, frame: Frame<HostMessage>): void => {
  const outcome = accept(context.ledger.load(), frame);
  if (outcome.kind !== "Accepted") {
    throw new Error(`frame ${frame.seq} was handled but the ledger no longer takes it (${outcome.kind})`);
  }
  context.ledger.save(outcome.ledger);
};

export const beat = (context: ControlContext): void => context.port.send(heartbeat(context.now()));
