import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { R2Bucket } from "../packages/control-plane/test/scenarios/harness/runtime.ts";
import { writePackLists } from "./write-pack-lists.mjs";

const digestOf = (text) => createHash("sha256").update(text).digest("hex");

test("writes the pack list of a snapshot root that has none", async () => {
  const store = new R2Bucket();
  const fileChunk = digestOf("file");
  const filePack = digestOf("file pack");
  const manifest = JSON.stringify({
    entries: [
      {
        kind: "File",
        path: "/workspace/a",
        mode: 420,
        uid: 1000,
        gid: 1000,
        mtimeSeconds: 0,
        mtimeNanos: 0,
        sizeBytes: 4,
        chunks: [{ digest: fileChunk, packDigest: filePack, offset: 0, length: 4 }],
      },
    ],
  });
  const manifestPack = digestOf(manifest);
  await store.put(`t1/packs/${manifestPack}`, manifest);
  await store.put(
    "t1/s1/snapshots/00000001-a",
    JSON.stringify({
      manifest: [{ digest: manifestPack, packDigest: manifestPack, offset: 0, length: manifest.length }],
    }),
  );
  await store.put("t1/s1/snapshots/00000002-b", JSON.stringify({ manifest: [] }));
  await store.put("t1/s1/snapshots/00000002-b.packs", JSON.stringify(["kept"]));

  const logged = [];
  const unreadable = await writePackLists(
    store,
    () => Promise.resolve(),
    (line) => logged.push(line),
  );

  assert.deepEqual(unreadable, []);
  assert.deepEqual(logged, ["wrote the pack list of t1/s1/snapshots/00000001-a: 2 packs"]);
  const written = await store.get("t1/s1/snapshots/00000001-a.packs");
  assert.deepEqual(JSON.parse(await written.text()), [manifestPack, filePack].sort());
  const kept = await store.get("t1/s1/snapshots/00000002-b.packs");
  assert.deepEqual(JSON.parse(await kept.text()), ["kept"]);
});

test("stops with the key whose read R2 refused 11 times", async () => {
  const store = new R2Bucket();
  await store.put("t1/s1/snapshots/00000001-a", JSON.stringify({ manifest: [] }));
  store.failure = { operation: "get", prefix: "t1/s1/snapshots/00000001-a", error: new Error("rate limited") };
  const waits = [];

  await assert.rejects(
    writePackLists(store, async (ms) => waits.push(ms), console.log),
    /R2 refused the get of t1\/s1\/snapshots\/00000001-a\.packs 11 times \(rate limited\)/,
  );
  assert.deepEqual(waits, [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000]);
});
