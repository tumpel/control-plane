import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SqlValue } from "../src/metrics-store.ts";
import { drainPersonaFileCleanups, recordPersonaFileCleanups } from "../src/persona-file-cleanups.ts";

const MIGRATIONS = new URL("../migrations/tenant/", import.meta.url);

test("a failed blob delete leaves its cleanup for the next drain, and a held digest is never deleted", async () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  for (const name of readdirSync(MIGRATIONS).sort()) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  const sql = {
    exec: <T>(query: string, ...bindings: SqlValue[]) => {
      const rows = db.prepare(query).all(...bindings) as T[];
      return { toArray: () => rows };
    },
  };
  db.exec("INSERT INTO secret_sets (secret_set_id, name, created_at, updated_at) VALUES ('sst', 'default', 1, 1)");
  db.exec(
    "INSERT INTO personas (persona_id, tenant_id, name, harness, secret_set_id, created_at, updated_at) VALUES ('prs', 'tnt', 'Default', 'ClaudeCode', 'sst', 1, 1)",
  );
  db.exec(
    "INSERT INTO persona_files (persona_id, path, digest, size_bytes, created_at, updated_at) VALUES ('prs', 'CLAUDE.md', 'held', 1, 1, 1)",
  );
  db.exec(
    `INSERT INTO sessions (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at)
    VALUES ('ses', 'prn', 'hst', 'box', 'prs', 'https://github.com/acme/app', 'ClaudeCode', '2.1.4', 'model', 'Idle', 1, '', 1, 1)`,
  );
  db.exec(
    "INSERT INTO turns (turn_id, session_id, box_id, prompt, state, line_count, created_at, updated_at, host_id) VALUES ('trn', 'ses', 'box', 'hi', 'Running', 1, 1, 1, 'hst')",
  );
  db.exec("INSERT INTO turn_steer_inboxes (turn_id, created_at) VALUES ('trn', 1)");
  db.exec("INSERT INTO turn_steer_settings (turn_id, digest) VALUES ('trn', 'steered')");
  const deleted: string[][] = [];
  let failing = true;
  const store = {
    delete: async (keys: string[]) => {
      if (failing) throw new Error("object storage is down");
      deleted.push(keys);
    },
  };
  recordPersonaFileCleanups(sql, ["held", "steered", "gone"]);

  await assert.rejects(drainPersonaFileCleanups(sql, store, "tnt"), /object storage is down/);
  assert.deepEqual(
    db
      .prepare("SELECT digest FROM persona_file_cleanups")
      .all()
      .map((row) => row.digest),
    ["gone"],
  );

  failing = false;
  await drainPersonaFileCleanups(sql, store, "tnt");
  assert.deepEqual(deleted, [["tnt/persona-files/gone"]]);
  assert.deepEqual(db.prepare("SELECT digest FROM persona_file_cleanups").all(), []);
});
