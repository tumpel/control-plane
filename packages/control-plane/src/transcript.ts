import { TranscriptLineSchema } from "@tumpel/api/schemas";
import type { z } from "zod";

export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

export const DEFAULT_PAGE_LINES = 100;

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
