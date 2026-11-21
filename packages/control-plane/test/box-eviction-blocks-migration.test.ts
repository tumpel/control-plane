import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const MIGRATIONS = new URL("../migrations/tenant/", import.meta.url);
const migration = (name: string): string => readFileSync(new URL(name, MIGRATIONS), "utf8");

test("box eviction blocks migrate only stop failures without a later turn or snapshot", () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const name of readdirSync(MIGRATIONS).sort()) {
    if (name >= "0082") break;
    db.exec(migration(name));
  }
  const session = db.prepare(
    `INSERT INTO sessions (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at)
    VALUES (?, 'prn', 'hst', 'box', 'prs', 'https://github.com/acme/app', 'ClaudeCode', '2.1.4', 'model', 'Idle', 1, '', 100, 100)`,
  );
  const turn = db.prepare(
    `INSERT INTO turns (turn_id, session_id, box_id, prompt, state, line_count, created_at, updated_at)
    VALUES (?, ?, 'box', 'work', 'Completed', 1, 100, ?)`,
  );
  const failure = db.prepare(
    `INSERT INTO stop_failures (stop_failure_id, session_id, reason, detail, failed_at, created_at)
    VALUES (?, ?, 'BoxDirty', 'dirty', '2026-11-21T00:00:00Z', 200)`,
  );
  const snapshot = db.prepare(
    `INSERT INTO snapshots (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, created_at, updated_at)
    VALUES (?, ?, 'box', ?, 1, 'key', 1, ?, ?)`,
  );
  for (const id of ["blocked", "recovered", "tied", "continued"]) {
    session.run(id);
    turn.run(`turn-${id}`, id, id === "continued" ? 201 : 100);
    failure.run(`failure-${id}`, id);
  }
  snapshot.run("snapshot-recovered", "recovered", "turn-recovered", 201, 201);
  snapshot.run("snapshot-tied", "tied", "turn-tied", 200, 200);

  db.exec(migration("0082_box_eviction_blocks.sql"));

  assert.deepEqual(
    db
      .prepare("SELECT session_id FROM box_eviction_blocks ORDER BY session_id")
      .all()
      .map((row) => row.session_id),
    ["blocked", "tied"],
  );
});
