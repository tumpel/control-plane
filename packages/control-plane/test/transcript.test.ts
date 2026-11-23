import assert from "node:assert/strict";
import { test } from "node:test";
import { type Compactor, compactorOf } from "../src/compact.ts";
import {
  type ChunkLedger,
  type ChunkStore,
  ChunkWriter,
  decodeLines,
  emptyPage,
  type Page,
  type PageRead,
  pageOf,
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

const read = (paged: PageRead): Page => {
  assert.ok(paged.ok);
  return paged.page;
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
  assert.deepEqual(
    SAMPLE.map((text) => claudeCode()(JSON.parse(text))),
    [
      null,
      "Reading the config.",
      "[Read] /work/app/tumpel.json",
      null,
      `Now the build.\n[Bash] npm run build ${"x".repeat(400 - "npm run build ".length)}…`,
      null,
    ],
  );
});

test("a compact page drops lines without ending early, and its cursor passes the dropped tail", () => {
  const page = read(
    pageOf(
      emptyPage(0),
      SAMPLE.map((text, index) => line(index + 1, text)),
      claudeCode(),
      64,
      32768,
    ),
  );
  assert.deepEqual(
    page.lines.map((kept) => kept.lineSeq),
    [2, 3, 5],
  );
  assert.equal(page.cursor, 6);
});

test("a page with no line to read keeps the cursor it was given", () => {
  assert.deepEqual(read(pageOf(emptyPage(7), [], claudeCode(), 64, 100)), emptyPage(7));
  assert.deepEqual(read(pageOf(emptyPage(7), [], null, 64, 100)), emptyPage(7));
});

test("a compact cut leaves the dropped lines before the cut line behind the cursor", () => {
  const lines = [
    line(1, assistant({ type: "text", text: "aaaa" })),
    line(2, JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } })),
    line(3, assistant({ type: "text", text: "bbbb" })),
  ];
  const page = read(pageOf(emptyPage(0), lines, claudeCode(), 64, 6));
  assert.deepEqual(
    page.lines.map((kept) => kept.lineSeq),
    [1],
  );
  assert.equal(page.cursor, 2);
});

test("a compact page names the first line that is not JSON instead of throwing", () => {
  const lines = [line(1, assistant({ type: "text", text: "aaaa" })), line(2, "npm ERR! not json"), line(3, "{}")];
  assert.deepEqual(pageOf(emptyPage(0), lines, claudeCode(), null, 32768), { ok: false, lineSeq: 2 });
  assert.equal(read(pageOf(emptyPage(0), lines, null, null, 32768)).lines.length, 3);
});

test("a compact page without a limit keeps every line up to the byte cap", () => {
  const lines = Array.from({ length: 1500 }, (_, index) => line(index + 1, assistant({ type: "text", text: "x" })));
  const page = read(pageOf(emptyPage(0), lines, claudeCode(), null, 1048576));
  assert.equal(page.lines.length, 1500);
  assert.equal(page.full, false);
});

const signal = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("lines that arrive during a slow chunk write go into the next chunk, and every line is stored once in order", async () => {
  const tenantId = "ten_serial";
  const sessionId = "ses_serial";
  const turnId = "trn_serial";
  const pending: TranscriptLine[] = [];
  const index: { storageKey: string; lineSeqs: number[] }[] = [];
  const ledger: ChunkLedger = {
    pending: () => [...pending],
    record: (_sessionId, _turnId, storageKey, chunk) => {
      const last = chunk.lineSeqs.at(-1) ?? 0;
      pending.splice(0, pending.filter((line) => line.lineSeq <= last).length);
      index.push({ storageKey, lineSeqs: chunk.lineSeqs });
    },
  };
  const stored = new Map<string, string>();
  const puts: string[] = [];
  const writing = signal();
  const held = signal();
  const spied: ChunkStore = {
    put: async (key, body) => {
      puts.push(key);
      if (puts.length === 1) {
        writing.resolve();
        await held.promise;
      }
      stored.set(key, new TextDecoder().decode(body));
    },
  };
  const writer = new ChunkWriter(ledger, spied);
  const writes: Promise<void>[] = [];
  const deliver = (lineSeq: number): void => {
    pending.push({ sessionId, lineSeq, tenantId, turnId, text: `line ${lineSeq}`, createdAt: Date.now() });
    if (pending.length >= 2) writes.push(writer.write(tenantId, sessionId, turnId, 2));
  };
  deliver(1);
  deliver(2);
  await writing.promise;
  deliver(3);
  deliver(4);
  deliver(5);
  writes.push(writer.write(tenantId, sessionId, turnId, 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(puts.length, 1);
  held.resolve();
  await Promise.all(writes);
  assert.deepEqual(
    index.map((entry) => entry.lineSeqs),
    [
      [1, 2],
      [3, 4, 5],
    ],
  );
  assert.deepEqual(pending, []);
  const chunks = index.map(({ storageKey }) => {
    const text = stored.get(storageKey);
    assert.ok(text !== undefined, `chunk ${storageKey} is stored`);
    return decodeLines(text);
  });
  assert.deepEqual(
    chunks.flat().map(({ lineSeq, text }) => ({ lineSeq, text })),
    [1, 2, 3, 4, 5].map((lineSeq) => ({ lineSeq, text: `line ${lineSeq}` })),
  );
});
