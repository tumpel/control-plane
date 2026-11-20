import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const MIGRATIONS = new URL("../migrations/tenant/", import.meta.url);
const migration = (name: string): string => readFileSync(new URL(name, MIGRATIONS), "utf8");

test("session ownership migration resumes after an interruption with many rows", () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  for (const name of readdirSync(MIGRATIONS).sort()) {
    if (name >= "0073") break;
    db.exec(migration(name));
  }
  db.exec(
    `INSERT INTO sessions (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at)
    VALUES ('ses', 'prn', 'hst', 'box', 'prs', 'https://github.com/acme/app', 'ClaudeCode', '2.1.4', 'model', 'Archived', 1, '', 1000, 1000)`,
  );
  db.exec(
    `WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < 10000)
    INSERT INTO turns (turn_id, session_id, box_id, prompt, state, line_count, created_at, updated_at, host_id)
    SELECT printf('trn-%05d', n), 'ses', 'box', 'hello', 'Completed', 1, 1000, 1000, 'hst' FROM rows`,
  );
  db.exec(
    `INSERT INTO credential_handovers (credential_handover_id, turn_id, host_id, variable_names, created_at)
    SELECT 'chd-' || turn_id, turn_id, 'hst', '[]', 1000 FROM turns`,
  );

  db.exec("DROP TRIGGER credential_handovers_append_only_delete");
  db.exec(migration("0073_session_ownership.sql"));
  db.exec(migration("0073_session_ownership.sql"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM turns").get()?.n, 10000);
  assert.equal(db.prepare("SELECT count(*) AS n FROM credential_handovers").get()?.n, 10000);
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO transcript_pending (session_id, line_seq, turn_id, text, created_at) VALUES ('missing', 1, 'trn', '', 1000)",
      ),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO transcript_chunks (session_id, first_line_seq, last_line_seq, turn_id, storage_key, line_seqs, offsets) VALUES ('missing', 1, 1, 'trn', 'key', '[]', '[]')",
      ),
    /FOREIGN KEY constraint failed/,
  );
  db.exec("INSERT INTO events (payload, created_at) VALUES ('{}', 1000)");
  assert.throws(
    () => db.exec("INSERT INTO event_sessions (event_id, session_id) VALUES (1, 'missing')"),
    /FOREIGN KEY constraint failed/,
  );

  db.exec("DELETE FROM sessions WHERE session_id = 'ses'");

  assert.equal(db.prepare("SELECT count(*) AS n FROM turns").get()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM credential_handovers").get()?.n, 0);
});
