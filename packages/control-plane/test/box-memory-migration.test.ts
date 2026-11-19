import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const MIGRATIONS = new URL("../migrations/tenant/", import.meta.url);
const migration = (name: string): string => readFileSync(new URL(name, MIGRATIONS), "utf8");

test("box memory keeps stored personas at their size, leaves the sessions table as it is, and holds new sizes between 512 and 65536 MiB", () => {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS).sort()) {
    if (name >= "0065") break;
    db.exec(migration(name));
  }
  db.exec(
    "INSERT INTO secret_sets (secret_set_id, name, created_at, updated_at) VALUES ('sst', 'default', 1000, 1000)",
  );
  const persona = db.prepare(
    `INSERT INTO personas (persona_id, tenant_id, name, harness, secret_set_id, box_memory_mib, created_at, updated_at)
    VALUES (?, 'tnt', ?, 'ClaudeCode', 'sst', ?, 1000, 1000)`,
  );
  persona.run("prs_stored", "stored", 4096);
  const session = db.prepare(
    `INSERT INTO sessions (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at)
    VALUES (?, 'prn', 'hst', 'box', 'prs_stored', 'https://github.com/acme/app', 'ClaudeCode', '2.1.4', 'model', 'Idle', 1, '', 1000, 1000)`,
  );
  session.run("ses_stored");
  const sessionsTable = (): unknown => db.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get()?.sql;
  const before = sessionsTable();

  db.exec(migration("0065_box_memory_min_512.sql"));

  assert.equal(sessionsTable(), before);
  persona.run("prs_small", "small", 512);
  assert.throws(
    () => persona.run("prs_tiny", "tiny", 511),
    /CHECK constraint failed: box_memory_mib BETWEEN 512 AND 65536/,
  );
  assert.deepEqual(
    db
      .prepare("SELECT persona_id, box_memory_mib FROM personas ORDER BY persona_id")
      .all()
      .map((row) => ({ ...row })),
    [
      { persona_id: "prs_small", box_memory_mib: 512 },
      { persona_id: "prs_stored", box_memory_mib: 4096 },
    ],
  );
  session.run("ses_small");
  session.run("ses_tiny");
  const sized = db.prepare("INSERT INTO session_box_memory (session_id, box_memory_mib) VALUES (?, ?)");
  sized.run("ses_small", 512);
  assert.throws(() => sized.run("ses_tiny", 511), /CHECK constraint failed: box_memory_mib BETWEEN 512 AND 65536/);
});
