import { TranscriptLineSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import type { Compactor } from "./compact.ts";

export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

export const chunkKey = (tenantId: string, sessionId: string, turnId: string, firstLineSeq: number): string =>
  `${tenantId}/${sessionId}/${turnId}/${String(firstLineSeq).padStart(16, "0")}.jsonl`;

export interface Chunk {
  body: Uint8Array;
  lineSeqs: number[];
  offsets: number[];
}

const encodeLine = (line: TranscriptLine): Uint8Array => new TextEncoder().encode(`${JSON.stringify(line)}\n`);

export const encodeChunk = (lines: TranscriptLine[]): Chunk => {
  const encoded = lines.map(encodeLine);
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

const offsetAt = (offsets: number[], index: number, lines: number): number => {
  const offset = offsets[index];
  if (offset === undefined)
    throw new Error(`a transcript chunk index holds ${lines} lines but ${offsets.length} offsets`);
  return offset;
};

export const rangeAfter = (
  lineSeqs: number[],
  offsets: number[],
  after: number,
  limit: number,
  maxBytes: number | null,
): Range | null => {
  const first = lineSeqs.findIndex((lineSeq) => lineSeq > after);
  if (first === -1) return null;
  const offset = offsetAt(offsets, first, lineSeqs.length);
  let end = Math.min(lineSeqs.length, first + limit);
  while (maxBytes !== null && end > first + 1 && offsetAt(offsets, end, lineSeqs.length) - offset > maxBytes) end -= 1;
  return { offset, length: offsetAt(offsets, end, lineSeqs.length) - offset };
};

export const linesWithin = (lines: TranscriptLine[], maxBytes: number | null): TranscriptLine[] => {
  if (maxBytes === null) return lines;
  let bytes = 0;
  const kept: TranscriptLine[] = [];
  for (const line of lines) {
    bytes += encodeLine(line).byteLength;
    if (kept.length > 0 && bytes > maxBytes) return kept;
    kept.push(line);
  }
  return kept;
};

export const decodeLines = (text: string): TranscriptLine[] =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => TranscriptLineSchema.parse(JSON.parse(line)));

export const DEFAULT_PAGE_BYTES = 32768;

export interface Page {
  lines: TranscriptLine[];
  cursor: number;
  bytes: number;
  full: boolean;
}

export const emptyPage = (after: number): Page => ({ lines: [], cursor: after, bytes: 0, full: false });

export type PageRead = { ok: true; page: Page } | { ok: false; lineSeq: number };

type Compacted = { ok: true; text: string | null } | { ok: false };

const parsedJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

const compacted = (compact: Compactor, text: string): Compacted => {
  const parsed = parsedJson(text);
  return parsed.ok ? { ok: true, text: compact(parsed.value) } : parsed;
};

export const pageOf = (
  page: Page,
  read: TranscriptLine[],
  compact: Compactor | null,
  limit: number | null,
  maxBytes: number,
): PageRead => {
  const encoder = new TextEncoder();
  const lines = [...page.lines];
  let { bytes, cursor } = page;
  const done = (full: boolean): PageRead => ({ ok: true, page: { lines, cursor, bytes, full } });
  for (const line of read) {
    const kept = compact === null ? { ok: true as const, text: line.text } : compacted(compact, line.text);
    if (!kept.ok) return { ok: false, lineSeq: line.lineSeq };
    const { text } = kept;
    if (text !== null) {
      const size = compact === null ? encodeLine(line).byteLength : encoder.encode(text).byteLength;
      if (lines.length > 0 && bytes + size > maxBytes) return done(true);
      bytes += size;
      lines.push({ ...line, text });
    }
    cursor = line.lineSeq;
    if (limit !== null && lines.length >= limit) return done(true);
  }
  return done(false);
};

export interface ChunkLedger {
  pending(tenantId: string, sessionId: string, turnId: string): TranscriptLine[];
  record(sessionId: string, turnId: string, storageKey: string, chunk: Chunk): void;
}

export interface ChunkStore {
  put(key: string, body: Uint8Array): Promise<unknown>;
}

export class ChunkWriter {
  readonly #writes = new Map<string, Promise<void>>();
  readonly #ledger: ChunkLedger;
  readonly #store: ChunkStore;

  constructor(ledger: ChunkLedger, store: ChunkStore) {
    this.#ledger = ledger;
    this.#store = store;
  }

  write(tenantId: string, sessionId: string, turnId: string, minLines: number): Promise<void> {
    const run = (): Promise<void> => this.#writeNow(tenantId, sessionId, turnId, minLines);
    const previous = this.#writes.get(sessionId) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.#writes.set(sessionId, next);
    const forget = (): void => {
      if (this.#writes.get(sessionId) === next) this.#writes.delete(sessionId);
    };
    next.then(forget, forget);
    return next;
  }

  async #writeNow(tenantId: string, sessionId: string, turnId: string, minLines: number): Promise<void> {
    const lines = this.#ledger.pending(tenantId, sessionId, turnId);
    const first = lines[0];
    if (first === undefined || lines.length < minLines) return;
    const chunk = encodeChunk(lines);
    const storageKey = chunkKey(tenantId, sessionId, turnId, first.lineSeq);
    await this.#store.put(storageKey, chunk.body);
    this.#ledger.record(sessionId, turnId, storageKey, chunk);
  }
}
