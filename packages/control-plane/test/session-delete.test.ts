import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const MIGRATIONS = new URL("../migrations/tenant/", import.meta.url);

test("deleting a session removes its turns and their credential handovers", () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  for (const name of readdirSync(MIGRATIONS).sort()) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  db.exec(
    `INSERT INTO sessions (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at)
    VALUES ('ses', 'prn', 'hst', 'box', 'prs', 'https://github.com/acme/app', 'ClaudeCode', '2.1.4', 'model', 'Archived', 1, '', 1000, 1000)`,
  );
  db.exec(
    `INSERT INTO turns (turn_id, session_id, box_id, prompt, state, line_count, created_at, updated_at, host_id)
    VALUES ('trn', 'ses', 'box', 'hello', 'Completed', 1, 1000, 1000, 'hst')`,
  );
  db.exec(
    `INSERT INTO credential_handovers (credential_handover_id, turn_id, host_id, variable_names, created_at)
    VALUES ('chd', 'trn', 'hst', '[]', 1000)`,
  );

  db.exec("DELETE FROM sessions WHERE session_id = 'ses'");

  assert.equal(db.prepare("SELECT count(*) AS n FROM turns").get()?.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM credential_handovers").get()?.n, 0);
});
