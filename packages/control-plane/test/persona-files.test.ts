import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PersonaFileLimit } from "@tumpel/api/schemas";
import { catalogEntry } from "../src/harness-catalog.ts";
import { checkFiles, type PersonaFileWrite } from "../src/persona-files.ts";

const claudeCode = catalogEntry("ClaudeCode", "2.0.0");
if (claudeCode === undefined) throw new Error("the catalog lists no ClaudeCode 2.0.0");

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
    `personas.create gives ClaudeCode a file at .bashrc, which ClaudeCode 2.0.0 does not read; it accepts ${claudeCode.personaFilePaths.join(", ")}`,
  );
  const repeated = await checkFiles(claudeCode, [inline(".claude.json", 2), inline(".claude.json", 2)], "test");
  assert.ok(!repeated.ok);
  assert.equal(repeated.problem.title, "Repeated persona file");
});
