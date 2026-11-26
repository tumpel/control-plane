import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import {
  CHUNK_BYTES,
  failsSnapshot,
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

const RestoreDownloadsSchema = z.object({
  reply: z.object({ type: z.literal("RestoreDownloads"), packs: z.array(z.object({ packDigest: z.string() })) }),
});
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
  for (let ms = await world.alarmStep(); ms !== null; ms = await world.alarmStep()) steps.push(ms);
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
  assert.equal(await world.alarmStep(), null, "the run waits 10 minutes for more releases");
  await world.tick(10 * MINUTE_MS);
  const first = await world.alarmStep();
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
  assert.notEqual(await world.alarmStep(), null, "the archive starts a run");

  await world.sendTurn(kept.sessionId, "change one file");
  const second = host.takeOffer();
  await host.claims(second);
  await host.completes(second);
  const request = snapshotAsked(host, kept.sessionId);
  const manifest = JSON.stringify({ entries: [] });
  const rootDigest = createHash("sha256").update(manifest).digest("hex");
  const root = { digest: rootDigest, packDigest: rootDigest, offset: 0, length: Buffer.byteLength(manifest) };
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
  await host.says({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: 1,
    packs: [],
    chunks: [],
    reusedPackDigests: [reused, rootDigest],
  });
  await host.says({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 0, chunkCount: 500 });
  assert.equal(await world.store.head(`${kept.storageKey}.packs`), null, "the newer snapshot released the older");
  const steps = await cleanupSteps(world);

  assert.ok(steps.length > 0, "the run finishes past the released input");
  assert.notEqual(await world.store.head(packKey(reused)), null, "the reused old pack stays");
});

test("a pack only a failed upload names stays through a cleanup run, and another session's snapshot reusing it stores", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const other = await startsStored(world, host, "another tree", tree(10, "other"));
  const first = await world.startSession({ prompt: "build the held tree", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const failed = snapshotAsked(host, first.sessionId);
  const held = sha256("held pack");
  const chunk = { digest: sha256("held chunk"), packDigest: held, offset: 0, length: CHUNK_BYTES };
  await host.says({
    type: "SnapshotPacks",
    snapshotId: failed.snapshotId,
    part: 1,
    packs: [{ packDigest: held, sizeBytes: CHUNK_BYTES }],
    chunks: [chunk],
    reusedPackDigests: [],
  });
  await world.store.put(packKey(held), "pack");
  await failsSnapshot(host, failed.snapshotId);
  await world.tick(61 * MINUTE_MS);
  await archives(world, other.sessionId);
  await world.tick(10 * MINUTE_MS);
  const steps = await cleanupSteps(world);
  assert.ok(steps.length > 0, "the archive runs a cleanup");
  assert.notEqual(await world.store.head(packKey(held)), null, "the failed upload's pack list keeps its pack");

  const second = await world.startSession({ prompt: "build on the held tree", tags: [] });
  const next = host.takeOffer();
  await host.claims(next);
  await host.completes(next);
  const request = snapshotAsked(host, second.sessionId);
  const manifest = JSON.stringify({ entries: [] }, null, 2);
  const rootDigest = createHash("sha256").update(manifest).digest("hex");
  const root = { digest: rootDigest, packDigest: rootDigest, offset: 0, length: Buffer.byteLength(manifest) };
  await host.says({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: 1,
    packs: [{ packDigest: rootDigest, sizeBytes: root.length }],
    chunks: [root],
    reusedPackDigests: [held],
  });
  await world.store.put(packKey(rootDigest), manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
  await host.says({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: root.length, chunkCount: 2 });

  const snapshots = SnapshotsSchema.parse(
    await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: second.sessionId }),
  );
  assert.deepEqual(
    snapshots.snapshots.map((snapshot) => snapshot.outcome.state),
    ["Stored"],
  );
});

test("a refused snapshot's packs survive a cleanup run, so the box's next snapshot reusing them stores and restores", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.holdsAgentCredentials();
  const other = await startsStored(world, host, "another tree", tree(10, "other"));
  const session = await world.startSession({ prompt: "build the base tree", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const refused = snapshotAsked(host, session.sessionId);
  const base = sha256("base pack");
  const chunk = { digest: sha256("base chunk"), packDigest: base, offset: 0, length: CHUNK_BYTES };
  await host.says({
    type: "SnapshotPacks",
    snapshotId: refused.snapshotId,
    part: 1,
    packs: [{ packDigest: base, sizeBytes: CHUNK_BYTES }],
    chunks: [chunk],
    reusedPackDigests: [],
  });
  await world.store.put(packKey(base), "pack");
  await host.says({ type: "SnapshotDone", snapshotId: refused.snapshotId, uploadedBytes: CHUNK_BYTES, chunkCount: 1 });
  await world.restartTenant();
  await world.tick(61 * MINUTE_MS);
  await archives(world, other.sessionId);
  await world.tick(10 * MINUTE_MS);
  const steps = await cleanupSteps(world);
  assert.ok(steps.length > 0, "the archive runs a cleanup");

  const { turnId } = await world.sendTurn(session.sessionId, "change one file");
  const next = host.takeOffer();
  await host.claims(next);
  await host.completes(next);
  const reasked = snapshotAsked(host, session.sessionId);
  assert.notEqual(reasked.snapshotId, refused.snapshotId, "the refusal asks the turn's snapshot again");
  const request = snapshotAsked(host, session.sessionId);
  const manifest = JSON.stringify({ entries: [] }, null, 4);
  const rootDigest = createHash("sha256").update(manifest).digest("hex");
  const root = { digest: rootDigest, packDigest: rootDigest, offset: 0, length: Buffer.byteLength(manifest) };
  await host.says({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: 1,
    packs: [{ packDigest: rootDigest, sizeBytes: root.length }],
    chunks: [root],
    reusedPackDigests: [base],
  });
  await world.store.put(packKey(rootDigest), manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
  await host.says({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: root.length, chunkCount: 2 });

  const snapshots = SnapshotsSchema.parse(
    await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: session.sessionId }),
  );
  assert.deepEqual(snapshots.snapshots.map((snapshot) => snapshot.outcome.state).sort(), ["Failed", "Stored"]);
  const restored = RestoreDownloadsSchema.parse(
    await host.says({ type: "RestoreChunks", turnId, part: 1, chunks: [chunk] }),
  );
  assert.deepEqual(
    restored.reply.packs.map((pack) => pack.packDigest),
    [base],
  );
});

test("a failure recorded before this change, with a draft and no pack list, has its draft's packs kept by a cleanup run", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const other = await startsStored(world, host, "another tree", tree(10, "other"));
  const session = await world.startSession({ prompt: "build the old tree", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const failed = snapshotAsked(host, session.sessionId);
  const held = sha256("old held pack");
  const chunk = { digest: sha256("old held chunk"), packDigest: held, offset: 0, length: CHUNK_BYTES };
  await host.says({
    type: "SnapshotPacks",
    snapshotId: failed.snapshotId,
    part: 1,
    packs: [{ packDigest: held, sizeBytes: CHUNK_BYTES }],
    chunks: [chunk],
    reusedPackDigests: [],
  });
  await world.store.put(packKey(held), "pack");
  await failsSnapshot(host, failed.snapshotId);
  assert.equal(await world.store.head(`${failed.storageKey}.packs`), null, "the failure has no pack list");
  await world.restartTenant();
  await world.tick(61 * MINUTE_MS);
  await archives(world, other.sessionId);
  await world.tick(10 * MINUTE_MS);
  const steps = await cleanupSteps(world);

  assert.ok(steps.length > 0, "the archive runs a cleanup");
  assert.notEqual(await world.store.head(packKey(held)), null, "the failure's draft keeps its pack");
});

test("an idle session whose last snapshot was refused does not stop cleanup: a run deletes an old orphan and keeps the refused snapshot's packs", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const other = await startsStored(world, host, "another tree", tree(10, "other"));
  const session = await world.startSession({ prompt: "build the refused tree", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const refused = snapshotAsked(host, session.sessionId);
  const base = sha256("refused base pack");
  const chunk = { digest: sha256("refused base chunk"), packDigest: base, offset: 0, length: CHUNK_BYTES };
  await host.says({
    type: "SnapshotPacks",
    snapshotId: refused.snapshotId,
    part: 1,
    packs: [{ packDigest: base, sizeBytes: CHUNK_BYTES }],
    chunks: [chunk],
    reusedPackDigests: [],
  });
  await world.store.put(packKey(base), "pack");
  await host.says({ type: "SnapshotDone", snapshotId: refused.snapshotId, uploadedBytes: CHUNK_BYTES, chunkCount: 1 });
  const orphan = packKey(sha256("orphan beside a refused snapshot"));
  await world.store.put(orphan, "pack");
  await world.restartTenant();
  await world.tick(61 * MINUTE_MS);
  await archives(world, other.sessionId);
  await world.tick(10 * MINUTE_MS);
  const steps = await cleanupSteps(world);

  assert.ok(steps.length > 0, "the archive runs a cleanup");
  assert.equal(await world.store.head(orphan), null, "the unrelated old orphan goes");
  assert.notEqual(await world.store.head(packKey(base)), null, "the refused snapshot's pack stays");
});

test("a written pack object storage already holds is presigned again and survives a cleanup run", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const named = tree(10, "named");
  const written = named[0]?.packDigest ?? "";
  await startsStored(world, host, "the named tree", named);
  const other = await startsStored(world, host, "another tree", tree(10, "other"));
  await world.tick(61 * MINUTE_MS);
  const session = await world.startSession({ prompt: "write the named pack again", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const request = snapshotAsked(host, session.sessionId);
  const manifest = JSON.stringify({ entries: [] }, null, 3);
  const rootDigest = createHash("sha256").update(manifest).digest("hex");
  const root = { digest: rootDigest, packDigest: rootDigest, offset: 0, length: Buffer.byteLength(manifest) };
  const chunk = { digest: sha256("written chunk"), packDigest: written, offset: 0, length: CHUNK_BYTES };
  const answer = PackUploadsSchema.parse(
    await host.says({
      type: "SnapshotPacks",
      snapshotId: request.snapshotId,
      part: 1,
      packs: [
        { packDigest: written, sizeBytes: CHUNK_BYTES },
        { packDigest: rootDigest, sizeBytes: root.length },
      ],
      chunks: [chunk, root],
      reusedPackDigests: [],
    }),
  );
  assert.deepEqual(answer.reply.uploads.map((upload) => upload.packDigest).sort(), [written, rootDigest].sort());
  for (const upload of answer.reply.uploads) await world.store.put(packKey(upload.packDigest), "pack");
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
  await archives(world, other.sessionId);
  await world.tick(10 * MINUTE_MS);
  const steps = await cleanupSteps(world);

  assert.ok(steps.length > 0, "the archive runs a cleanup");
  assert.notEqual(await world.store.head(packKey(written)), null, "the written pack stays");
});

test("a pack an open upload names and writes again between the sweep's draft mark and its delete survives, and the snapshot stores and restores", async (t) => {
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
  await archives(world, other.sessionId);
  await world.restartTenant();
  await world.tick(10 * MINUTE_MS);
  assert.notEqual(await world.alarmStep(), null, "the archive starts a run");
  const manifest = JSON.stringify({ entries: [] }, null, 1);
  const rootDigest = createHash("sha256").update(manifest).digest("hex");
  const root = { digest: rootDigest, packDigest: rootDigest, offset: 0, length: Buffer.byteLength(manifest) };
  const chunk = { digest: sha256("raced chunk"), packDigest: raced, offset: 0, length: CHUNK_BYTES };
  await host.says({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: 1,
    packs: [{ packDigest: rootDigest, sizeBytes: root.length }],
    chunks: [root],
    reusedPackDigests: [],
  });
  await world.store.put(packKey(rootDigest), manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
  const list = world.store.list.bind(world.store);
  const presigned: string[] = [];
  t.mock.method(world.store, "list", async (options: Parameters<typeof list>[0]) => {
    const listed = await list(options);
    const answer = PackUploadsSchema.parse(
      await host.says({
        type: "SnapshotPacks",
        snapshotId: request.snapshotId,
        part: 2,
        packs: [{ packDigest: raced, sizeBytes: CHUNK_BYTES }],
        chunks: [chunk],
        reusedPackDigests: [],
      }),
    );
    presigned.push(...answer.reply.uploads.map((upload) => upload.packDigest));
    await world.store.put(packKey(raced), "pack");
    return listed;
  });
  await cleanupSteps(world);
  t.mock.restoreAll();
  assert.deepEqual(presigned, [raced], "the old orphan is presigned again after the draft mark");
  await host.says({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: CHUNK_BYTES, chunkCount: 2 });

  const snapshots = SnapshotsSchema.parse(
    await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: session.sessionId }),
  );
  assert.deepEqual(
    snapshots.snapshots.map((snapshot) => snapshot.outcome.state),
    ["Stored"],
  );
  assert.notEqual(await world.store.head(packKey(raced)), null, "the written pack survives the delete");
  const restored = RestoreDownloadsSchema.parse(
    await host.says({ type: "RestoreChunks", turnId: offer.turnId, part: 1, chunks: [chunk] }),
  );
  assert.deepEqual(
    restored.reply.packs.map((pack) => pack.packDigest),
    [raced],
  );
});

for (const packsPerList of [30, 1]) {
  test(`1400 archives in 10 minutes start one run over 1400 live snapshots of ${packsPerList} packs each, each step within the budget on a restarted tenant`, {
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
      const packs = Array.from({ length: packsPerList }, (_, pack) => sha256(`seeded ${at} pack ${pack}`));
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
    await world.store.put(`${TENANT_ID}/live-packs.json`, "{}");
    await world.restartTenant();
    const get = world.store.get.bind(world.store);
    const read: string[] = [];
    t.mock.method(world.store, "get", (key: string, options?: Parameters<typeof get>[1]) => {
      read.push(key);
      return get(key, options);
    });
    const steps = await cleanupSteps(world);
    assert.ok(!read.includes(`${TENANT_ID}/live-packs.json`), "no cleanup step reads the live pack names");

    console.log(`${packsPerList} packs a list: ${steps.length} steps, the slowest ${Math.max(...steps).toFixed(2)} ms`);
    assert.ok(steps.length > 1, "one run of several steps");
    assert.ok(Math.max(...steps) <= BUDGET_MS, `every step stays within ${BUDGET_MS} ms: ${steps.join(", ")}`);
    assert.equal(await world.tenantStorage(TENANT_ID).getAlarm(), null, "the archives fold into that one run");
    for (const key of orphans) assert.equal(await world.store.head(key), null, "every old orphan goes");
    assert.notEqual(
      await world.store.head(packKey(sha256(`seeded 1399 pack ${packsPerList - 1}`))),
      null,
      "live packs stay",
    );
  });
}

test("a draft that grows past 256 KiB between the sweep's draft mark and its delete makes that step delete nothing, and a later step marks it and deletes", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const live = await startsStored(world, host, "the live tree", tree(10, "live"));
  const archived = await startsStored(world, host, "the archived tree", tree(10, "archived"));
  const orphan = packKey(sha256("orphan beside a growing draft"));
  const grown = Array.from({ length: 4000 }, (_, at) => sha256(`grown pack ${at}`));
  await world.store.put(orphan, "pack");
  await world.store.put(packKey(grown[0] ?? ""), "pack");
  await world.tick(61 * MINUTE_MS);
  const storageKey = `${TENANT_ID}/snapshots/open-growing`;
  world
    .tenantSql()
    .exec(
      "INSERT INTO snapshot_requests (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, created_at) SELECT ?, session_id, box_id, turn_id, ?, ?, ? FROM snapshots WHERE storage_key = ?",
      "open-growing",
      100,
      storageKey,
      Date.now(),
      live.storageKey,
    );
  await world.store.put(
    `${storageKey}.draft`,
    JSON.stringify({ lastPart: 1, packs: [sha256("first pack")], reused: [] }),
  );
  await archives(world, archived.sessionId);
  await world.tick(10 * MINUTE_MS);
  await world.restartTenant();
  const list = world.store.list.bind(world.store);
  let lists = 0;
  t.mock.method(world.store, "list", async (options: Parameters<typeof list>[0]) => {
    lists += 1;
    if (lists === 1) {
      const draft = JSON.stringify({ lastPart: 2, packs: grown, reused: [] });
      assert.ok(Buffer.byteLength(draft) > 256 * 1024);
      await world.store.put(`${storageKey}.draft`, draft);
    }
    return list(options);
  });
  while (lists === 0) assert.notEqual(await world.alarmStep(), null, "the run reaches its first delete step");

  assert.notEqual(await world.store.head(orphan), null, "the step that saw the grown draft deletes nothing");
  await cleanupSteps(world);
  assert.ok(lists > 1, "a later delete step lists again");
  assert.equal(await world.store.head(orphan), null, "the old orphan goes");
  assert.notEqual(await world.store.head(packKey(grown[0] ?? "")), null, "the grown draft's old pack stays");
});
