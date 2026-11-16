import {
  ControlEnvelopeSchema,
  type ControlFrameSchema,
  HelloSchema,
  HostEnvelopeSchema,
  type HostFrameSchema,
  type HostUsageSchema,
} from "@tumpel/schemas";
import type { z } from "zod";

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_DEADLINE_MS = 30_000;
export const CHANNEL_PATH = /^\/v1\/hosts\/([^/]+)\/channel$/;

export const HelloVersionSchema = HelloSchema.pick({ type: true, protocolVersion: true });
export { ControlEnvelopeSchema, HostEnvelopeSchema };

export type HostEnvelope = z.infer<typeof HostEnvelopeSchema>;
export type ControlEnvelope = z.infer<typeof ControlEnvelopeSchema>;
export type Hello = Extract<HostEnvelope, { type: "Hello" }>;
export type HostUsage = z.infer<typeof HostUsageSchema>;
export type HostFrame = z.infer<typeof HostFrameSchema>;
export type ControlFrame = z.infer<typeof ControlFrameSchema>;
export type HostMessage = HostFrame["message"];
export type ControlMessage = ControlFrame["message"];
export type TurnOffer = Extract<ControlMessage, { type: "TurnOffer" }>;
export type DispatchGrant = TurnOffer["credential"];
export type SnapshotDownload = TurnOffer["snapshots"][number];
export type OfferParts = Pick<
  TurnOffer,
  "credential" | "lastLineSeq" | "snapshots" | "personaFiles" | "image" | "gitAuthorName" | "gitAuthorEmail"
>;
export type PersonaFileDownload = TurnOffer["personaFiles"][number];
export type BootImage = TurnOffer["image"];
export type StoredOffer = Omit<TurnOffer, keyof OfferParts>;
export type ClaudeSetupBoxOffer = Extract<ControlMessage, { type: "ClaudeSetupBoxOffer" }>;
export type ClaudeSetupBoxCode = Extract<ControlMessage, { type: "ClaudeSetupBoxCode" }>;
export type StoredClaudeSetupOffer = Pick<ClaudeSetupBoxOffer, "type" | "claudeSetupId" | "boxId">;
export type StoredClaudeSetupCode = Pick<ClaudeSetupBoxCode, "type" | "claudeSetupId" | "boxId">;
export type StoredControlMessage =
  | Exclude<ControlMessage, { type: "TurnOffer" | "ClaudeSetupBoxOffer" | "ClaudeSetupBoxCode" }>
  | StoredOffer
  | StoredClaudeSetupOffer
  | StoredClaudeSetupCode;
export type PreparedOffer = ({ kind: "Ready" } & OfferParts) | { kind: "Withdrawn" };
export type PreparedClaudeSetup =
  | { kind: "Ready"; message: ClaudeSetupBoxOffer | ClaudeSetupBoxCode }
  | { kind: "Withdrawn"; message: Extract<ControlMessage, { type: "ClaudeSetupBoxDiscard" }> };

export interface Port<Out> {
  send(envelope: Out): void;
  close(code: number, reason: string): void;
}

export interface Frame<M> {
  type: "Frame";
  seq: number;
  ack: number;
  message: M;
}

export interface Ledger<M> {
  received: number;
  sent: number;
  unacked: Frame<M>[];
}

export interface LedgerStore<M> {
  load(): Promise<Ledger<M>>;
  save(ledger: Ledger<M>): Promise<void>;
}

export const emptyLedger = <M>(): Ledger<M> => ({ received: 0, sent: 0, unacked: [] });

const HELLO_CONTEXT = "tumpel-channel-hello-v1";

export const helloBytes = (nonce: string, hostId: string): Uint8Array<ArrayBuffer> => {
  const encoder = new TextEncoder();
  const separator = new Uint8Array([0]);
  const parts = [encoder.encode(HELLO_CONTEXT), separator, encoder.encode(nonce), separator, encoder.encode(hostId)];
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

export const sequence = <M>(ledger: Ledger<M>, message: M): { ledger: Ledger<M>; frame: Frame<M> } => {
  const frame: Frame<M> = { type: "Frame", seq: ledger.sent + 1, ack: ledger.received, message };
  return { ledger: { ...ledger, sent: frame.seq, unacked: [...ledger.unacked, frame] }, frame };
};

export type Accepted<Own, Theirs> =
  | { kind: "Accepted"; ledger: Ledger<Own>; message: Theirs }
  | { kind: "Duplicate" }
  | { kind: "Gap"; expected: number; got: number };

export const accept = <Own, Theirs>(ledger: Ledger<Own>, frame: Frame<Theirs>): Accepted<Own, Theirs> => {
  if (frame.seq <= ledger.received) return { kind: "Duplicate" };
  if (frame.seq !== ledger.received + 1) return { kind: "Gap", expected: ledger.received + 1, got: frame.seq };
  return {
    kind: "Accepted",
    ledger: {
      received: frame.seq,
      sent: ledger.sent,
      unacked: ledger.unacked.filter((own) => own.seq > frame.ack),
    },
    message: frame.message,
  };
};

export const resend = async <Stored, M>(
  ledger: Ledger<Stored>,
  restore: (stored: Stored) => Promise<M>,
): Promise<Frame<M>[]> => {
  const frames: Frame<M>[] = [];
  for (const frame of ledger.unacked) {
    frames.push({ ...frame, ack: ledger.received, message: await restore(frame.message) });
  }
  return frames;
};

export const heartbeat = (now: Date): { type: "Heartbeat"; sentAt: string } => ({
  type: "Heartbeat",
  sentAt: now.toISOString(),
});

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

export const parseEnvelope = <T>(schema: z.ZodType<T>, text: string): Parsed<T> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the message is not JSON" };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    reason: `the message matches no channel envelope: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "message"}: ${issue.message}`).join("; ")}`,
  };
};

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const decodeBase64 = (text: string): Uint8Array<ArrayBuffer> | null =>
  BASE64.test(text) ? Uint8Array.from(atob(text), (char) => char.charCodeAt(0)) : null;

export const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const randomNonce = (): string =>
  encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
