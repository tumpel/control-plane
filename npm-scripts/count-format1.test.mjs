import assert from "node:assert/strict";
import { test } from "node:test";
import { R2Bucket } from "../packages/control-plane/test/scenarios/harness/runtime.ts";
import { countFormat1 } from "./count-format1.mjs";

test("prints the live snapshot whose manifest is JSON and skips the one whose manifest is a chunk list", async () => {
  const store = new R2Bucket();
  const json = JSON.stringify({ entries: [] });
  await store.put("t1/packs/json-pack", `padding${json}`);
  await store.put(
    "t1/s1/snapshots/00000001-a",
    JSON.stringify({ manifest: [{ digest: "json", packDigest: "json-pack", offset: 7, length: json.length }] }),
  );
  await store.put("t1/s1/snapshots/00000001-a.packs", JSON.stringify(["json-pack"]));
  await store.put("t1/packs/list-pack", "paddingTPCL\u0001\u0000\u0000\u0000");
  await store.put(
    "t1/s2/snapshots/00000001-b",
    JSON.stringify({ manifest: [{ digest: "list", packDigest: "list-pack", offset: 7, length: 8 }] }),
  );

  const logged = [];
  const count = await countFormat1(
    store,
    () => Promise.resolve(),
    (line) => logged.push(line),
  );

  assert.equal(count, 1);
  assert.deepEqual(logged, ["t1/s1/snapshots/00000001-a"]);
});

test("stops with the key whose read R2 refused 11 times", async () => {
  const store = new R2Bucket();
  await store.put("t1/s1/snapshots/00000001-a", JSON.stringify({ manifest: [] }));
  store.failure = { operation: "get", prefix: "t1/s1/snapshots/00000001-a", error: new Error("rate limited") };
  const waits = [];

  await assert.rejects(
    countFormat1(store, async (ms) => waits.push(ms), console.log),
    /R2 refused the get of t1\/s1\/snapshots\/00000001-a 11 times \(rate limited\)/,
  );
  assert.deepEqual(waits, [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000]);
});
