import {
  accept,
  CloseCode,
  ControlEnvelopeSchema,
  type ControlMessage,
  type HostEnvelope,
  type HostMessage,
  heartbeat,
  helloBytes,
  type LedgerStore,
  type Port,
  PROTOCOL_VERSION,
  parseEnvelope,
  resend,
  sequence,
} from "./protocol.ts";

export type HostConnection =
  | { phase: "AwaitingChallenge" }
  | { phase: "AwaitingWelcome" }
  | { phase: "Open" }
  | { phase: "Closed" };

export interface HostContext {
  port: Port<HostEnvelope>;
  hostId: string;
  supervisorVersion: string;
  ledger: LedgerStore<HostMessage>;
  sign(bytes: Uint8Array): Promise<string>;
  now(): Date;
}

export type HostEvent =
  | { kind: "None" }
  | { kind: "Welcomed" }
  | { kind: "Heartbeat" }
  | { kind: "Message"; message: ControlMessage }
  | { kind: "Revoked"; reason: string }
  | { kind: "Closed"; code: number; reason: string };

interface Received {
  connection: HostConnection;
  event: HostEvent;
}

const closed = (port: Port<HostEnvelope>, code: number, reason: string): Received => {
  port.close(code, reason);
  return { connection: { phase: "Closed" }, event: { kind: "Closed", code, reason } };
};

export const connecting = (): HostConnection => ({ phase: "AwaitingChallenge" });

export const send = (connection: HostConnection, message: HostMessage, context: HostContext): void => {
  const { ledger, frame } = sequence(context.ledger.load(), message);
  context.ledger.save(ledger);
  if (connection.phase === "Open") context.port.send(frame);
};

export const receive = async (connection: HostConnection, text: string, context: HostContext): Promise<Received> => {
  if (connection.phase === "Closed") return { connection, event: { kind: "None" } };
  const parsed = parseEnvelope(ControlEnvelopeSchema, text);
  if (!parsed.ok) return closed(context.port, CloseCode.ProtocolError, parsed.reason);
  const envelope = parsed.value;
  if (connection.phase === "AwaitingChallenge") {
    if (envelope.type !== "Challenge") {
      return closed(context.port, CloseCode.ProtocolError, `expected Challenge first, got ${envelope.type}`);
    }
    context.port.send({
      type: "Hello",
      hostId: context.hostId,
      protocolVersion: PROTOCOL_VERSION,
      supervisorVersion: context.supervisorVersion,
      signature: await context.sign(helloBytes(envelope.nonce, context.hostId)),
    });
    return { connection: { phase: "AwaitingWelcome" }, event: { kind: "None" } };
  }
  if (envelope.type === "Challenge" || (envelope.type === "Welcome" && connection.phase === "Open")) {
    return closed(context.port, CloseCode.ProtocolError, `${envelope.type} arrived on an open connection`);
  }
  if (envelope.type === "Welcome") {
    for (const frame of resend(context.ledger.load())) context.port.send(frame);
    return { connection: { phase: "Open" }, event: { kind: "Welcomed" } };
  }
  if (envelope.type === "Heartbeat") return { connection, event: { kind: "Heartbeat" } };
  if (connection.phase === "AwaitingWelcome" && envelope.message.type !== "Revoke") {
    return closed(context.port, CloseCode.ProtocolError, `${envelope.message.type} arrived before Welcome`);
  }
  const outcome = accept(context.ledger.load(), envelope);
  if (outcome.kind === "Duplicate") return { connection, event: { kind: "None" } };
  if (outcome.kind === "Gap") {
    return closed(
      context.port,
      CloseCode.ProtocolError,
      `frame gap: expected seq ${outcome.expected}, got ${outcome.got}`,
    );
  }
  context.ledger.save(outcome.ledger);
  if (outcome.message.type === "Revoke") {
    return { connection: { phase: "Closed" }, event: { kind: "Revoked", reason: outcome.message.reason } };
  }
  return { connection, event: { kind: "Message", message: outcome.message } };
};

export const beat = (context: HostContext): void => context.port.send(heartbeat(context.now()));
