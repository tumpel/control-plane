import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Compactor,
  compactorOf,
  encodeChunk,
  pageOf,
  rangeAfter,
  type TranscriptLine,
} from "../src/transcript.ts";

const line = (lineSeq: number, text: string): TranscriptLine => ({
  sessionId: "ses_1",
  lineSeq,
  tenantId: "ten_1",
  turnId: "trn_1",
  text,
  createdAt: 0,
});

const claudeCode = (): Compactor => {
  const compactor = compactorOf("ClaudeCode");
  assert.ok(compactor);
  return compactor;
};

const assistant = (...content: unknown[]): string => JSON.stringify({ type: "assistant", message: { content } });

const SAMPLE = [
  JSON.stringify({ type: "system", subtype: "init" }),
  assistant({ type: "text", text: "Reading the config." }),
  assistant({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/app/tumpel.json", limit: 10 } }),
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a very long file body" }] },
  }),
  assistant(
    { type: "text", text: "Now the build." },
    { type: "tool_use", id: "t2", name: "Bash", input: { command: `npm run build\n${"x".repeat(600)}` } },
  ),
  JSON.stringify({ type: "result", result: "done" }),
];

test("compact keeps assistant text, shortens a tool call to its name and first argument, and drops tool results", () => {
  assert.deepEqual(SAMPLE.map(claudeCode()), [
    null,
    "Reading the config.",
    "[Read] /work/app/tumpel.json",
    null,
    `Now the build.\n[Bash] npm run build ${"x".repeat(400 - "npm run build ".length)}…`,
    null,
  ]);
});

test("a compact page drops lines without ending early, and its cursor passes the dropped tail", () => {
  const page = pageOf(
    SAMPLE.map((text, index) => line(index + 1, text)),
    0,
    claudeCode(),
    32768,
  );
  assert.deepEqual(
    page.lines.map((kept) => kept.lineSeq),
    [2, 3, 5],
  );
  assert.equal(page.cursor, 6);
});

test("a page with no line to read keeps the cursor it was given", () => {
  assert.deepEqual(pageOf([], 7, claudeCode(), 100), { lines: [], cursor: 7 });
  assert.deepEqual(pageOf([], 7, null, 100), { lines: [], cursor: 7 });
});

test("only ClaudeCode has a compact form", () => {
  assert.equal(compactorOf("Codex"), null);
  assert.equal(compactorOf("OpenCode"), null);
  assert.equal(compactorOf("PiDev"), null);
});

test("a raw read cuts a chunk on a line boundary at the byte cap and always holds one line", () => {
  const lines = [line(4, "a".repeat(10)), line(5, "b".repeat(10)), line(6, "c".repeat(10)), line(7, "d".repeat(10))];
  const { lineSeqs, offsets } = encodeChunk(lines);
  const size = (offsets[1] ?? 0) - (offsets[0] ?? 0);
  assert.deepEqual(rangeAfter(lineSeqs, offsets, 3, 10, size * 2 + 1), { offset: 0, length: size * 2 });
  assert.deepEqual(rangeAfter(lineSeqs, offsets, 5, 10, size * 2), { offset: size * 2, length: size * 2 });
  assert.deepEqual(rangeAfter(lineSeqs, offsets, 3, 10, 1), { offset: 0, length: size });
  assert.deepEqual(rangeAfter(lineSeqs, offsets, 3, 3, null), { offset: 0, length: size * 3 });
  assert.equal(rangeAfter(lineSeqs, offsets, 7, 10, null), null);
});

test("a compact cut leaves the dropped lines before the cut line behind the cursor", () => {
  const lines = [
    line(1, assistant({ type: "text", text: "aaaa" })),
    line(2, JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } })),
    line(3, assistant({ type: "text", text: "bbbb" })),
  ];
  const page = pageOf(lines, 0, claudeCode(), 6);
  assert.deepEqual(
    page.lines.map((kept) => kept.lineSeq),
    [1],
  );
  assert.equal(page.cursor, 2);
});
