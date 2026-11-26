import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import {
  CHUNK_BYTES,
  PackUploadsSchema,
  type Placement,
  parts,
  sha256,
  snapshotAsked,
  TENANT_ID,
  tree,
  uploadsChunks,
} from "./harness/snapshot-chunks.ts";
import { type Host, UNMETERED, World } from "./harness/world.ts";

const BUDGET_MS = 30;
const MINUTE_MS = 60_000;

const SnapshotsSchema = z.object({ snapshots: z.array(z.object({ outcome: z.object({ state: z.string() }) })) });

const packKey = (packDigest: string): string => `${TENANT_ID}/packs/${packDigest}`;

const storesSnapshot = async (
  world: World,
  host: Host,
  sessionId: string,
  chunks: Placement[],
): Promise<{ snapshotId: string; storageKey: string }> => {
  const request = snapshotAsked(host, sessionId);
  await uploadsChunks(world, host, request.snapshotId, chunks);
  const manifest = JSON.stringify({ entries: [] });
  const digest = createHash("sha256").update(manifest).digest("hex");
  await world.store.put(packKey(digest), manifest);
  const root = { digest, packDigest: digest, offset: 0, length: Buffer.byteLength(manifest) };
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
  await host.says({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: parts(chunks).length + 1,
    packs: [{ packDigest: digest, sizeBytes: root.length }],
    chunks: [root],
    reusedPackDigests: [],
  });
  await host.says({
    type: "SnapshotDone",
    snapshotId: request.snapshotId,
    uploadedBytes: chunks.length * CHUNK_BYTES,
    chunkCount: chunks.length,
  });
  return request;
};

const startsStored = async (
  world: World,
  host: Host,
  name: string,
  chunks: Placement[],
): Promise<{ sessionId: string; storageKey: string }> => {
  const session = await world.startSession({ prompt: `build ${name}`, tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const { storageKey } = await storesSnapshot(world, host, session.sessionId, chunks);
  return { sessionId: session.sessionId, storageKey };
};

const archives = (world: World, sessionId: string): Promise<unknown> =>
  world.call("archiveSession", { tenantId: TENANT_ID, sessionId, now: Date.now() });

const cleanupSteps = async (world: World): Promise<number[]> => {
  const steps: number[] = [];
  for (let ms = await world.alarm(); ms !== null; ms = await world.alarm()) steps.push(ms);
  return steps;
};

test("a cleanup run after a release deletes an orphan pack older than an hour, keeps a younger one and every live pack, and survives a restart between steps", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const liveChunks = tree(1000, "live");
  await startsStored(world, host, "the live tree", liveChunks);
  const released = await startsStored(world, host, "the released tree", tree(10, "released"));
  const old = packKey(sha256("old orphan"));
  await world.store.put(old, "pack");
  await world.tick(31 * MINUTE_MS);
  const young = packKey(sha256("young orphan"));
  await world.store.put(young, "pack");
  await world.tick(20 * MINUTE_MS);

  await archives(world, released.sessionId);
  await world.restartTenant();
  assert.equal(await world.alarm(), null, "the run waits 10 minutes for more releases");
  await world.tick(10 * MINUTE_MS);
  const first = await world.alarm();
  assert.notEqual(first, null, "the release starts a run after 10 minutes");
  await world.restartTenant();
  const steps = await cleanupSteps(world);

  assert.ok(steps.length > 0, "the restarted tenant runs a fresh run to its end");
  assert.ok(Math.max(...steps) <= BUDGET_MS, `every step stays within ${BUDGET_MS} ms: ${steps.join(", ")}`);
  assert.equal(await world.store.head(old), null, "the orphan older than an hour goes");
  assert.notEqual(await world.store.head(young), null, "the orphan 30 minutes old stays");
  for (const packDigest of new Set(liveChunks.map((chunk) => chunk.packDigest))) {
    assert.notEqual(await world.store.head(packKey(packDigest)), null, "a live snapshot's pack stays");
  }
});

test("a snapshot stored during a run keeps the old pack it reuses from the snapshot it releases, and the run skips the released input", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.holdsAgentCredentials();
  const chunks = tree(500, "reused");
  const reused = chunks[0]?.packDigest ?? "";
  const kept = await startsStored(world, host, "the reused tree", chunks);
  const other = await startsStored(world, host, "another tree", tree(10, "other"));
  await world.tick(61 * MINUTE_MS);
  await archives(world, other.sessionId);
  await world.tick(10 * MINUTE_MS);
  assert.notEqual(await world.alarm(), null, "the archive starts a run");

  await world.sendTurn(kept.sessionId, "change one file");
  const second = host.takeOffer();
  await host.claims(second);
  await host.completes(second);
  const request = snapshotAsked(host, kept.sessionId);
  await host.says({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: 1,
    packs: [],
    chunks: [],
    reusedPackDigests: [reused],
  });
  await host.says({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 0, chunkCount: 500 });
  assert.equal(await world.store.head(`${kept.storageKey}.packs`), null, "the newer snapshot released the older");
  const steps = await cleanupSteps(world);

  assert.ok(steps.length > 0, "the run finishes past the released input");
  assert.notEqual(await world.store.head(packKey(reused)), null, "the reused old pack stays");
});

test("a pack uploaded again between the sweep's listing and its delete makes the snapshot naming it refuse, never store", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const other = await startsStored(world, host, "another tree", tree(10, "other"));
  const raced = sha256("raced pack");
  await world.store.put(packKey(raced), "pack");
  await world.tick(61 * MINUTE_MS);
  const session = await world.startSession({ prompt: "build the raced tree", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const request = snapshotAsked(host, session.sessionId);
  const manifest = JSON.stringify({ entries: [] }, null, 1);
  const rootDigest = createHash("sha256").update(manifest).digest("hex");
  const root = { digest: rootDigest, packDigest: rootDigest, offset: 0, length: Buffer.byteLength(manifest) };
  const chunk = { digest: sha256("raced chunk"), packDigest: raced, offset: 0, length: CHUNK_BYTES };
  const answer = PackUploadsSchema.parse(
    await host.says({
      type: "SnapshotPacks",
      snapshotId: request.snapshotId,
      part: 1,
      packs: [
        { packDigest: raced, sizeBytes: CHUNK_BYTES },
        { packDigest: rootDigest, sizeBytes: root.length },
      ],
      chunks: [chunk, root],
      reusedPackDigests: [],
    }),
  );
  assert.ok(
    answer.reply.uploads.some((upload) => upload.packDigest === raced),
    "the old orphan is presigned again",
  );
  await world.store.put(packKey(rootDigest), manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
  await archives(world, other.sessionId);
  await world.tick(10 * MINUTE_MS);
  const list = world.store.list.bind(world.store);
  t.mock.method(world.store, "list", async (options: Parameters<typeof list>[0]) => {
    const listed = await list(options);
    await world.store.put(packKey(raced), "pack");
    return listed;
  });
  await cleanupSteps(world);
  t.mock.restoreAll();
  await host.says({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: CHUNK_BYTES, chunkCount: 1 });

  const snapshots = SnapshotsSchema.parse(
    await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: session.sessionId }),
  );
  assert.deepEqual(
    snapshots.snapshots.map((snapshot) => snapshot.outcome.state),
    ["Failed"],
  );
});

test("1400 archives in 10 minutes start one run over 1400 live snapshots, each step within the budget on a restarted tenant", {
  timeout: 600_000,
}, async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const live = await startsStored(world, host, "the live tree", tree(10, "live"));
  const archived = await startsStored(world, host, "the archived tree", tree(10, "archived"));
  const sql = world.tenantSql();
  for (let at = 0; at < 1400; at++) {
    const storageKey = `${TENANT_ID}/snapshots/seeded-${at}`;
    sql.exec(
      "INSERT INTO snapshots (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, created_at, updated_at) SELECT ?, session_id, box_id, turn_id, ?, ?, size_bytes, created_at, updated_at FROM snapshots WHERE storage_key = ?",
      `seeded-${at}`,
      at + 100,
      storageKey,
      live.storageKey,
    );
    const packs = Array.from({ length: 30 }, (_, pack) => sha256(`seeded ${at} pack ${pack}`));
    await world.store.put(`${storageKey}.packs`, JSON.stringify(packs));
    for (const packDigest of packs) await world.store.put(packKey(packDigest), "pack");
  }
  const orphans = Array.from({ length: 3000 }, (_, at) => packKey(sha256(`orphan ${at}`)));
  for (const key of orphans) await world.store.put(key, "pack");
  await world.tick(61 * MINUTE_MS);

  const firstAt = Date.now();
  for (let at = 0; at < 1400; at++) {
    await archives(world, archived.sessionId);
    await world.tick(380);
  }
  await world.tick(firstAt + 10 * MINUTE_MS - Date.now());
  await world.restartTenant();
  const steps = await cleanupSteps(world);

  console.log(`${steps.length} steps, the slowest ${Math.max(...steps).toFixed(2)} ms`);
  assert.ok(steps.length > 1, "one run of several steps");
  assert.ok(Math.max(...steps) <= BUDGET_MS, `every step stays within ${BUDGET_MS} ms: ${steps.join(", ")}`);
  assert.equal(await world.tenantStorage(TENANT_ID).getAlarm(), null, "the archives fold into that one run");
  for (const key of orphans) assert.equal(await world.store.head(key), null, "every old orphan goes");
  assert.notEqual(await world.store.head(packKey(sha256("seeded 1399 pack 29"))), null, "live packs stay");
});
