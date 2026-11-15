import { type HarnessSchema, TranscriptLineSchema } from "@tumpel/api/schemas";
import { z } from "zod";

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
const TOOL_ARGUMENT_CHARS = 400;

type Harness = z.infer<typeof HarnessSchema>;

const ClaudeCodeAssistantSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("tool_use"), name: z.string(), input: z.record(z.string(), z.unknown()) }),
        z.object({ type: z.string() }),
      ]),
    ),
  }),
});

const oneLine = (value: string): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > TOOL_ARGUMENT_CHARS ? `${flat.slice(0, TOOL_ARGUMENT_CHARS)}…` : flat;
};

const toolCall = (name: string, input: Record<string, unknown>): string => {
  const [first] = Object.values(input);
  if (first === undefined) return `[${name}]`;
  return `[${name}] ${oneLine(typeof first === "string" ? first : JSON.stringify(first))}`;
};

const compactClaudeCode = (text: string): string | null => {
  const assistant = ClaudeCodeAssistantSchema.safeParse(JSON.parse(text));
  if (!assistant.success) return null;
  const parts = assistant.data.message.content.flatMap((block): string[] => {
    if ("text" in block && block.text !== "") return [block.text];
    if ("name" in block) return [toolCall(block.name, block.input)];
    return [];
  });
  return parts.length === 0 ? null : parts.join("\n");
};

export type Compactor = (text: string) => string | null;

const COMPACTORS: Partial<Record<Harness, Compactor>> = { ClaudeCode: compactClaudeCode };

export const compactorOf = (harness: Harness): Compactor | null => COMPACTORS[harness] ?? null;

export interface Page {
  lines: TranscriptLine[];
  cursor: number;
}

export const pageOf = (read: TranscriptLine[], after: number, compact: Compactor | null, maxBytes: number): Page => {
  if (compact === null) return { lines: read, cursor: read.at(-1)?.lineSeq ?? after };
  const encoder = new TextEncoder();
  const lines: TranscriptLine[] = [];
  let bytes = 0;
  let previous = after;
  for (const line of read) {
    const text = compact(line.text);
    if (text !== null) {
      const size = encoder.encode(text).byteLength;
      if (lines.length > 0 && bytes + size > maxBytes) return { lines, cursor: previous };
      bytes += size;
      lines.push({ ...line, text });
    }
    previous = line.lineSeq;
  }
  return { lines, cursor: previous };
};
