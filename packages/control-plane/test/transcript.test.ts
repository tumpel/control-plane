import assert from "node:assert/strict";
import { test } from "node:test";
import { compactText, pageOf, type TranscriptLine } from "../src/transcript.ts";

const line = (lineSeq: number, text: string): TranscriptLine => ({
  sessionId: "ses_1",
  lineSeq,
  tenantId: "ten_1",
  turnId: "trn_1",
  text,
  createdAt: 0,
});

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
    { type: "tool_use", id: "t2", name: "Bash", input: { command: `npm run build\n${"x".repeat(300)}` } },
  ),
  JSON.stringify({ type: "result", result: "done" }),
];

test("compact keeps assistant text, shortens a tool call to its name and first argument, and drops tool results", () => {
  assert.deepEqual(SAMPLE.map(compactText), [
    null,
    "Reading the config.",
    "[Read] /work/app/tumpel.json",
    null,
    `Now the build.\n[Bash] npm run build ${"x".repeat(120 - "npm run build ".length)}…`,
    null,
  ]);
});

test("a compact page drops lines without ending early, and its nextCursor passes the dropped tail", () => {
  const page = pageOf(
    SAMPLE.map((text, index) => line(index + 1, text)),
    0,
    true,
    32768,
  );
  assert.deepEqual(
    page.lines.map((kept) => kept.lineSeq),
    [2, 3, 5],
  );
  assert.equal(page.nextCursor, 6);
});

test("a page with no line to read keeps the cursor it was given", () => {
  assert.deepEqual(pageOf([], 7, true, 100), { lines: [], nextCursor: 7 });
});

test("the byte cap cuts a page on a line boundary and nextCursor is the last line before the cut", () => {
  const lines = [line(4, "a".repeat(10)), line(5, "b".repeat(10)), line(6, "c".repeat(10)), line(7, "d".repeat(10))];
  const page = pageOf(lines, 3, false, 25);
  assert.deepEqual(
    page.lines.map((kept) => kept.lineSeq),
    [4, 5],
  );
  assert.equal(page.nextCursor, 5);
  const rest = pageOf(lines.slice(2), page.nextCursor, false, 25);
  assert.deepEqual(
    rest.lines.map((kept) => kept.lineSeq),
    [6, 7],
  );
  assert.equal(rest.nextCursor, 7);
});

test("the byte cap counts bytes, and a page always holds one line even when it exceeds the cap", () => {
  const page = pageOf([line(1, "é".repeat(10)), line(2, "ok")], 0, false, 5);
  assert.deepEqual(
    page.lines.map((kept) => kept.lineSeq),
    [1],
  );
  assert.equal(page.nextCursor, 1);
});

test("a compact cut leaves the dropped lines before the cut line behind the cursor", () => {
  const lines = [
    line(1, assistant({ type: "text", text: "aaaa" })),
    line(2, JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } })),
    line(3, assistant({ type: "text", text: "bbbb" })),
  ];
  const page = pageOf(lines, 0, true, 6);
  assert.deepEqual(
    page.lines.map((kept) => kept.lineSeq),
    [1],
  );
  assert.equal(page.nextCursor, 2);
});
