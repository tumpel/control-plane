import {
  accept,
  CloseCode,
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
  PROTOCOL_VERSION,
  parseEnvelope,
  randomNonce,
  resend,
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
  ledger: LedgerStore<ControlMessage>;
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

export const send = (connection: ControlConnection, message: ControlMessage, context: ControlContext): void => {
  const { ledger, frame } = sequence(context.ledger.load(), message);
  context.ledger.save(ledger);
  if (connection.phase === "Open") context.port.send(frame);
};

const revokeMessage = (context: ControlContext, reason: string): ControlMessage => ({
  type: "Revoke",
  hostId: context.host.hostId,
  reason,
});

export const revoke = (connection: ControlConnection, reason: string, context: ControlContext): Received => {
  if (connection.phase === "Open") send(connection, revokeMessage(context, reason), context);
  return close(context.port, CloseCode.Revoked, `host ${context.host.hostId} is revoked: ${reason}`);
};

const hello = async (
  connection: { phase: "AwaitingHello"; nonce: string },
  envelope: Hello,
  context: ControlContext,
): Promise<Received> => {
  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return close(
      context.port,
      CloseCode.UnsupportedVersion,
      `protocol version ${envelope.protocolVersion} is not supported; this control plane speaks ${PROTOCOL_VERSION}, update the supervisor`,
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
  if (context.host.revoked) {
    const open: ControlConnection = { phase: "Open" };
    for (const frame of resend(context.ledger.load())) context.port.send(frame);
    send(open, revokeMessage(context, "the tenant revoked this host"), context);
    return close(context.port, CloseCode.Revoked, `host ${context.host.hostId} is revoked`);
  }
  context.port.send({ type: "Welcome", hostId: context.host.hostId, protocolVersion: PROTOCOL_VERSION });
  for (const frame of resend(context.ledger.load())) context.port.send(frame);
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
  const outcome = accept(context.ledger.load(), envelope);
  if (outcome.kind === "Duplicate") return { connection, event: { kind: "None" } };
  if (outcome.kind === "Gap") {
    return close(
      context.port,
      CloseCode.ProtocolError,
      `frame gap: expected seq ${outcome.expected}, got ${outcome.got}`,
    );
  }
  context.ledger.save(outcome.ledger);
  return { connection, event: { kind: "Message", message: outcome.message } };
};

export const beat = (context: ControlContext): void => context.port.send(heartbeat(context.now()));
