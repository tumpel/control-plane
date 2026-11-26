import assert from "node:assert/strict";
import { test } from "node:test";
import { R2Bucket } from "../packages/control-plane/test/scenarios/harness/runtime.ts";
import { deleteLivePacks } from "./delete-live-packs.mjs";

test("a dry run prints every tenant's live-packs.json and deletes nothing; --delete deletes only those", async () => {
  const store = new R2Bucket();
  await store.put("t1/live-packs.json", "{}");
  await store.put("t2/live-packs.json", "{}");
  await store.put("t1/s1/live-packs.json", "{}");
  await store.put("t1/packs/p1", "pack");

  const dry = [];
  await deleteLivePacks(
    store,
    () => Promise.resolve(),
    (line) => dry.push(line),
    false,
  );
  assert.deepEqual(dry, ["would delete t1/live-packs.json", "would delete t2/live-packs.json"]);
  assert.notEqual(await store.head("t1/live-packs.json"), null, "a dry run deletes nothing");

  const deleted = [];
  await deleteLivePacks(
    store,
    () => Promise.resolve(),
    (line) => deleted.push(line),
    true,
  );
  assert.deepEqual(deleted, ["deleted t1/live-packs.json", "deleted t2/live-packs.json"]);
  assert.equal(await store.head("t1/live-packs.json"), null);
  assert.equal(await store.head("t2/live-packs.json"), null);
  assert.notEqual(await store.head("t1/s1/live-packs.json"), null, "only a tenant's top-level list goes");
  assert.notEqual(await store.head("t1/packs/p1"), null, "packs stay");
});

test("stops with the key whose delete R2 refused 11 times", async () => {
  const store = new R2Bucket();
  await store.put("t1/live-packs.json", "{}");
  store.failure = { operation: "delete", prefix: "t1/live-packs.json", error: new Error("rate limited") };
  const waits = [];

  await assert.rejects(
    deleteLivePacks(store, async (ms) => waits.push(ms), console.log, true),
    /R2 refused the delete of t1\/live-packs\.json 11 times \(rate limited\)/,
  );
  assert.deepEqual(waits, [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000]);
});
