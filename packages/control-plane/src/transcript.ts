import { TranscriptLineSchema } from "@tumpel/api/schemas";
import type { z } from "zod";

export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

export const chunkKey = (tenantId: string, sessionId: string, turnId: string, firstLineSeq: number): string =>
  `${tenantId}/${sessionId}/${turnId}/${String(firstLineSeq).padStart(16, "0")}.jsonl`;

export interface Chunk {
  body: Uint8Array;
  lineSeqs: number[];
  offsets: number[];
}

export const encodeChunk = (lines: TranscriptLine[]): Chunk => {
  const encoder = new TextEncoder();
  const encoded = lines.map((line) => encoder.encode(`${JSON.stringify(line)}\n`));
  const offsets = [0];
  for (const bytes of encoded) offsets.push((offsets.at(-1) ?? 0) + bytes.byteLength);
  const body = new Uint8Array(offsets.at(-1) ?? 0);
  encoded.forEach((bytes, index) => {
    body.set(bytes, offsets[index] ?? 0);
  });
  return { body, lineSeqs: lines.map((line) => line.lineSeq), offsets };
};

export interface Range {
  offset: number;
  length: number;
}

export const rangeAfter = (lineSeqs: number[], offsets: number[], after: number, limit: number): Range | null => {
  const first = lineSeqs.findIndex((lineSeq) => lineSeq > after);
  if (first === -1) return null;
  const end = Math.min(lineSeqs.length, first + limit);
  const offset = offsets[first];
  const until = offsets[end];
  if (offset === undefined || until === undefined) {
    throw new Error(`a transcript chunk index holds ${lineSeqs.length} lines but ${offsets.length} offsets`);
  }
  return { offset, length: until - offset };
};

export const decodeLines = (text: string): TranscriptLine[] =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => TranscriptLineSchema.parse(JSON.parse(line)));

export const DEFAULT_PAGE_BYTES = 32768;
const TOOL_ARGUMENT_CHARS = 120;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const oneLine = (value: string): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > TOOL_ARGUMENT_CHARS ? `${flat.slice(0, TOOL_ARGUMENT_CHARS)}…` : flat;
};

const toolCall = (block: Record<string, unknown>): string => {
  const name = typeof block.name === "string" ? block.name : "tool";
  const [first] = isRecord(block.input) ? Object.values(block.input) : [];
  if (first === undefined) return `[${name}]`;
  return `[${name}] ${oneLine(typeof first === "string" ? first : JSON.stringify(first))}`;
};

export const compactText = (text: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isRecord(parsed) || parsed.type !== "assistant" || !isRecord(parsed.message)) return null;
  const content = parsed.message.content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((block: unknown): string[] => {
    if (!isRecord(block)) return [];
    if (block.type === "text" && typeof block.text === "string" && block.text !== "") return [block.text];
    if (block.type === "tool_use") return [toolCall(block)];
    return [];
  });
  return parts.length === 0 ? null : parts.join("\n");
};

export interface Page {
  lines: TranscriptLine[];
  nextCursor: number;
}

export const pageOf = (read: TranscriptLine[], after: number, compact: boolean, maxBytes: number): Page => {
  const encoder = new TextEncoder();
  const lines: TranscriptLine[] = [];
  let bytes = 0;
  let previous = after;
  for (const line of read) {
    const text = compact ? compactText(line.text) : line.text;
    if (text !== null) {
      const size = encoder.encode(text).byteLength;
      if (lines.length > 0 && bytes + size > maxBytes) return { lines, nextCursor: previous };
      bytes += size;
      lines.push({ ...line, text });
    }
    previous = line.lineSeq;
  }
  return { lines, nextCursor: previous };
};
