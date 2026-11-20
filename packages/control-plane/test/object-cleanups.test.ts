import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { SqlValue } from "../src/metrics-store.ts";
import { drainObjectCleanups, recordObjectCleanups } from "../src/object-cleanups.ts";

const MIGRATIONS = new URL("../migrations/tenant/", import.meta.url);

test("a drain deletes every batch and keeps what a failed delete left for the next drain", async () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  for (const name of readdirSync(MIGRATIONS).sort()) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  const sql = {
    exec: <T>(query: string, ...bindings: SqlValue[]) => {
      const rows = db.prepare(query).all(...bindings) as T[];
      return { toArray: () => rows };
    },
  };
  const deleted: string[][] = [];
  let failing = true;
  const store = {
    delete: async (keys: string[]) => {
      if (failing) throw new Error("object storage is down");
      deleted.push(keys);
    },
  };
  const transcripts = Array.from(
    { length: 1001 },
    (_, index) => `tnt/ses/transcript/${String(index).padStart(4, "0")}`,
  );
  recordObjectCleanups(sql, transcripts);

  await assert.rejects(drainObjectCleanups(sql, store), /object storage is down/);
  assert.equal(db.prepare("SELECT count(*) AS left FROM object_cleanups").get()?.left, 1001);

  failing = false;
  await drainObjectCleanups(sql, store);
  assert.deepEqual(
    deleted.map((keys) => keys.length),
    [1000, 1],
  );
  assert.deepEqual(deleted.flat(), transcripts);
  assert.deepEqual(db.prepare("SELECT storage_key FROM object_cleanups").all(), []);
});
