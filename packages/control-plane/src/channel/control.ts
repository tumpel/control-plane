import { ChannelProtocol, CloseCode } from "@tumpel/api/schemas";
import {
  accept,
  type ControlEnvelope,
  type ControlMessage,
  decodeBase64,
  type Hello,
  HostEnvelopeSchema,
  type HostMessage,
  heartbeat,
  helloBytes,
  type LedgerStore,
  type Port,
  type PreparedOffer,
  parseEnvelope,
  randomNonce,
  resend,
  type StoredControlMessage,
  type StoredOffer,
  sequence,
} from "./protocol.ts";

export type ControlConnection = { phase: "AwaitingHello"; nonce: string } | { phase: "Open" } | { phase: "Closed" };

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
  now(): Date;
}

export type ControlEvent =
  | { kind: "None" }
  | { kind: "Welcomed" }
  | { kind: "Heartbeat" }
  | { kind: "Message"; message: HostMessage }
  | { kind: "Closed"; code: number; reason: string };

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
  if (stored.type !== "TurnOffer") return stored;
  const prepared = await context.prepareOffer(stored);
  if (prepared.kind === "Withdrawn") return { type: "TurnWithdrawn", turnId: stored.turnId };
  const { credential, lastLineSeq, snapshots, personaFiles, gitAuthorName, gitAuthorEmail } = prepared;
  return { ...stored, credential, lastLineSeq, snapshots, personaFiles, gitAuthorName, gitAuthorEmail };
};

export const send = async (
  connection: ControlConnection,
  message: StoredControlMessage,
  context: ControlContext,
): Promise<void> => {
  const { ledger, frame } = sequence(await context.ledger.load(), message);
  await context.ledger.save(ledger);
  if (connection.phase === "Open") {
    context.port.send({ ...frame, message: await outbound(frame.message, context) });
  }
};

export const revoke = (context: ControlContext, reason: string): Received =>
  close(context.port, CloseCode.Revoked, `host ${context.host.hostId} is revoked: ${reason}`);

const hello = async (
  connection: { phase: "AwaitingHello"; nonce: string },
  envelope: Hello,
  context: ControlContext,
): Promise<Received> => {
  if (envelope.protocolVersion !== ChannelProtocol.Version) {
    return close(
      context.port,
      CloseCode.UnsupportedVersion,
      `protocol version ${envelope.protocolVersion} is not supported; this control plane speaks ${ChannelProtocol.Version}, update the supervisor`,
    );
  }
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
  const resent = await resend(await context.ledger.load(), (stored) => outbound(stored, context));
  context.port.send({ type: "Welcome", hostId: context.host.hostId, protocolVersion: ChannelProtocol.Version });
  for (const frame of resent) context.port.send(frame);
  return { connection: { phase: "Open" }, event: { kind: "Welcomed" } };
};

export const receive = async (
  connection: ControlConnection,
  text: string,
  context: ControlContext,
): Promise<Received> => {
  if (connection.phase === "Closed") return { connection, event: { kind: "None" } };
  const parsed = parseEnvelope(HostEnvelopeSchema, text);
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
  if (envelope.type === "Heartbeat") return { connection, event: { kind: "Heartbeat" } };
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
