import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PersonaFileLimit } from "@tumpel/api/schemas";
import { CLAUDE_CODE_VERSION, catalogEntry } from "../src/harness-catalog.ts";
import { type BlobStore, checkFiles, type PersonaFileWrite, personaFileKey, storeFiles } from "../src/persona-files.ts";

const claudeCode = catalogEntry("ClaudeCode", CLAUDE_CODE_VERSION);
if (claudeCode === undefined) throw new Error(`the catalog lists no ClaudeCode ${CLAUDE_CODE_VERSION}`);

const inline = (path: string, bytes: number): PersonaFileWrite => ({
  source: "Inline",
  path,
  content: Buffer.alloc(bytes, "a").toString("base64"),
});

const stored = (path: string, sizeBytes: number): PersonaFileWrite => ({
  source: "Stored",
  path,
  digest: "0".repeat(64),
  sizeBytes,
});

test("an inline file at the cap is accepted with its digest, and one byte more is refused with the upload route", async () => {
  const atCap = await checkFiles(claudeCode, [inline(".claude/CLAUDE.md", PersonaFileLimit.InlineFileBytes)], "test");
  assert.ok(atCap.ok);
  assert.deepEqual(
    atCap.files.map(({ path, digest, sizeBytes }) => [path, digest, sizeBytes]),
    [
      [
        ".claude/CLAUDE.md",
        createHash("sha256").update(Buffer.alloc(PersonaFileLimit.InlineFileBytes, "a")).digest("hex"),
        PersonaFileLimit.InlineFileBytes,
      ],
    ],
  );
  const over = await checkFiles(
    claudeCode,
    [inline(".claude/CLAUDE.md", PersonaFileLimit.InlineFileBytes + 1)],
    "test",
  );
  assert.ok(!over.ok);
  assert.equal(over.problem.title, "Persona file too large to send inline");
  assert.match(over.problem.fix, /\/v1\/personas\/file-uploads/);
});

test("files that together pass the persona cap are refused, even when each fits", async () => {
  const fits = await checkFiles(
    claudeCode,
    [
      stored(".claude/CLAUDE.md", PersonaFileLimit.PersonaBytes - PersonaFileLimit.InlineFileBytes),
      inline(".claude/settings.json", PersonaFileLimit.InlineFileBytes),
    ],
    "test",
  );
  assert.ok(fits.ok);
  const over = await checkFiles(
    claudeCode,
    [
      stored(".claude/CLAUDE.md", PersonaFileLimit.PersonaBytes - PersonaFileLimit.InlineFileBytes + 1),
      inline(".claude/settings.json", PersonaFileLimit.InlineFileBytes),
    ],
    "test",
  );
  assert.ok(!over.ok);
  assert.equal(over.problem.title, "Persona files too large");
  assert.match(over.problem.detail, new RegExp(`${PersonaFileLimit.PersonaBytes + 1} bytes`));
});

test("a file at a path the harness does not read is refused with the paths it accepts", async () => {
  const refused = await checkFiles(claudeCode, [inline(".bashrc", 4)], "personas.create");
  assert.ok(!refused.ok);
  assert.equal(refused.problem.title, "Path not read by the harness");
  assert.equal(
    refused.problem.detail,
    `personas.create gives ClaudeCode a file at .bashrc, which ClaudeCode ${CLAUDE_CODE_VERSION} does not read; it accepts ${claudeCode.personaFilePaths.join(", ")}`,
  );
  const repeated = await checkFiles(claudeCode, [inline(".claude.json", 2), inline(".claude.json", 2)], "test");
  assert.ok(!repeated.ok);
  assert.equal(repeated.problem.title, "Repeated persona file");
});

class MemoryBlobs implements BlobStore {
  readonly blobs = new Map<string, Uint8Array<ArrayBuffer>>();

  async put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.blobs.set(key, bytes);
  }

  async get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const bytes = this.blobs.get(key);
    if (bytes === undefined) return null;
    return { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer };
  }
}

test("a stored file whose bytes do not hash to its digest is refused, and one that does is accepted", async () => {
  const bytes = new Uint8Array(Buffer.from('{"model":"opus"}'));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const store = new MemoryBlobs();
  const named = { path: ".claude/settings.json", digest, sizeBytes: bytes.byteLength, bytes: null };

  store.blobs.set(personaFileKey("tenant-1", digest), new Uint8Array(Buffer.from('{"model":"evil"}')));
  const refused = await storeFiles(store, "tenant-1", [named], "personas.create");
  assert.ok(!refused.ok);
  assert.equal(refused.problem.title, "Persona file digest differs");
  assert.match(
    refused.problem.detail,
    new RegExp(`by digest ${digest}, and the bytes the store holds under it hash to [0-9a-f]{64}`),
  );

  store.blobs.set(personaFileKey("tenant-1", digest), bytes);
  const accepted = await storeFiles(store, "tenant-1", [named], "personas.create");
  assert.deepEqual(accepted, {
    ok: true,
    files: [{ path: ".claude/settings.json", digest, sizeBytes: bytes.byteLength }],
  });
});
