import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const MIGRATIONS = new URL("../migrations/tenant/", import.meta.url);
const migration = (name: string): string => readFileSync(new URL(name, MIGRATIONS), "utf8");

test("sessions that predate the layer record read NotRecorded once they hold a snapshot, and BuildsPrebuild when they build one", () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const name of readdirSync(MIGRATIONS).sort()) {
    if (name >= "0059") break;
    db.exec(migration(name));
  }
  const session = db.prepare(
    `INSERT INTO sessions (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at)
    VALUES (?, 'prn', 'hst', 'box', 'prs', ?, 'ClaudeCode', '2.1.4', 'model', 'Idle', 1, '', 1000, 1000)`,
  );
  session.run("ses_snapshotted", "https://github.com/acme/app");
  session.run("ses_unsnapshotted", "https://github.com/acme/app");
  session.run("ses_builder", "https://github.com/acme/app");
  const snapshot = db.prepare(
    `INSERT INTO snapshots (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, created_at, updated_at)
    VALUES (?, ?, 'box', 'trn', 1, 'key', 1, 1000, 1000)`,
  );
  snapshot.run("snp_1", "ses_snapshotted");
  snapshot.run("snp_2", "ses_builder");
  db.prepare(
    "INSERT INTO prebuild_sessions (prebuild_id, session_id, created_at) VALUES ('pbd', 'ses_builder', 1000)",
  ).run();

  db.exec(migration("0059_turn_images_and_session_layers.sql"));

  assert.deepEqual(
    db
      .prepare("SELECT session_id, reason, detail FROM session_layer_absences ORDER BY session_id")
      .all()
      .map((row) => ({ ...row })),
    [
      {
        session_id: "ses_builder",
        reason: "BuildsPrebuild",
        detail:
          "the session builds a prebuild of https://github.com/acme/app, so its box starts from the guest image alone",
      },
      {
        session_id: "ses_snapshotted",
        reason: "NotRecorded",
        detail:
          "the session's first box booted before the control plane recorded which prebuild layer it restored; start a new session of https://github.com/acme/app to see the layer its box starts from",
      },
    ],
  );
});
