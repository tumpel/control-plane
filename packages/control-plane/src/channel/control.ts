import { ChannelProtocol, CloseCode, StoredHostFrameSchema } from "@tumpel/api/schemas";
import {
  accept,
  type ControlEnvelope,
  type ControlMessage,
  decodeBase64,
  type Frame,
  type Hello,
  HelloVersionSchema,
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
  resend,
  type StoredClaudeSetupCode,
  type StoredClaudeSetupOffer,
  type StoredControlMessage,
  type StoredOffer,
  sequence,
} from "./protocol.ts";

export type ControlConnection =
  | { phase: "AwaitingHello"; nonce: string }
  | { phase: "Open"; protocolVersion: number }
  | { phase: "Closed" };

export type MessageVersions = Record<StoredControlMessage["type"], number>;

export const CONTROL_MESSAGE_VERSIONS: MessageVersions = {
  TurnOffer: ChannelProtocol.Oldest,
  TurnWithdrawn: ChannelProtocol.Oldest,
  TurnClaimed: ChannelProtocol.Oldest,
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
  | { kind: "Welcomed"; boxCapacity: number; usage: HostUsage; supervisorVersion: string; protocolVersion: number }
  | { kind: "Heartbeat"; usage: HostUsage }
  | { kind: "Message"; message: HostMessage }
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

const outbound = async (stored: StoredControlMessage, context: ControlContext): Promise<ControlMessage> => {
  if (stored.type === "ClaudeSetupBoxOffer" || stored.type === "ClaudeSetupBoxCode") {
    return (await context.prepareClaudeSetup(stored)).message;
  }
  if (stored.type !== "TurnOffer") return stored;
  const prepared = await context.prepareOffer(stored);
  if (prepared.kind === "Withdrawn") return { type: "TurnWithdrawn", turnId: stored.turnId };
  const { credential, lastLineSeq, snapshots, personaFiles, image, gitAuthorName, gitAuthorEmail } = prepared;
  return { ...stored, credential, lastLineSeq, snapshots, personaFiles, image, gitAuthorName, gitAuthorEmail };
};

const unspoken = (
  protocolVersion: number,
  frame: Frame<StoredControlMessage>,
  context: ControlContext,
): Received | null => {
  const needed = context.messageVersions[frame.message.type];
  if (needed <= protocolVersion) return null;
  return close(
    context.port,
    CloseCode.UnsupportedVersion,
    `frame ${frame.seq} carries ${frame.message.type}, which needs protocol version ${needed}; this connection speaks ${protocolVersion}, update the supervisor`,
  );
};

export const send = async (
  connection: ControlConnection,
  message: StoredControlMessage,
  context: ControlContext,
): Promise<void> => {
  const { ledger, frame } = sequence(await context.ledger.load(), message);
  await context.ledger.save(ledger);
  if (connection.phase !== "Open") return;
  if (unspoken(connection.protocolVersion, frame, context) !== null) return;
  context.port.send({ ...frame, message: await outbound(frame.message, context) });
};

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
  const ledger = await context.ledger.load();
  for (const frame of ledger.unacked) {
    const refused = unspoken(envelope.protocolVersion, frame, context);
    if (refused !== null) return refused;
  }
  const resent = await resend(ledger, (stored) => outbound(stored, context));
  context.port.send({ type: "Welcome", hostId: context.host.hostId, protocolVersion: envelope.protocolVersion });
  for (const frame of resent) context.port.send(frame);
  return {
    connection: { phase: "Open", protocolVersion: envelope.protocolVersion },
    event: {
      kind: "Welcomed",
      boxCapacity: envelope.boxCapacity,
      usage: envelope.usage,
      supervisorVersion: envelope.supervisorVersion,
      protocolVersion: envelope.protocolVersion,
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
  const outcome = accept(await context.ledger.load(), stored.value);
  if (outcome.kind === "Duplicate") return { connection, event: { kind: "None" } };
  if (outcome.kind === "Gap") {
    return close(
      context.port,
      CloseCode.ProtocolError,
      `frame gap: expected seq ${outcome.expected}, got ${outcome.got}`,
    );
  }
  await context.ledger.save(outcome.ledger);
  context.port.send({ type: "FrameRefused", seq: stored.value.seq, reason });
  return { connection, event: { kind: "FrameRefused", seq: stored.value.seq, reason } };
};

export const receive = async (
  connection: ControlConnection,
  text: string,
  context: ControlContext,
): Promise<Received> => {
  if (connection.phase === "Closed") return { connection, event: { kind: "None" } };
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
  const parsed = parseEnvelope(HostEnvelopeSchema, text);
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
  if (envelope.type === "Heartbeat") return { connection, event: { kind: "Heartbeat", usage: envelope.usage } };
  const outcome = accept(await context.ledger.load(), envelope);
  if (outcome.kind === "Duplicate") return { connection, event: { kind: "None" } };
  if (outcome.kind === "Gap") {
    return close(
      context.port,
      CloseCode.ProtocolError,
      `frame gap: expected seq ${outcome.expected}, got ${outcome.got}`,
    );
  }
  await context.ledger.save(outcome.ledger);
  return { connection, event: { kind: "Message", message: outcome.message } };
};

export const beat = (context: ControlContext): void => context.port.send(heartbeat(context.now()));
