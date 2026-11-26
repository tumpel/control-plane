import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  CHUNK_BYTES,
  type Placement,
  type SnapshotRequestSchema,
  sha256,
  snapshotAsked,
  TENANT_ID,
} from "./harness/snapshot-chunks.ts";
import { type Host, UNMETERED, World } from "./harness/world.ts";

const BUDGET_MS = 30;
const MINUTE_MS = 60_000;

const SnapshotsSchema = z.object({ snapshots: z.array(z.object({ outcome: z.object({ state: z.string() }) })) });
const OfferSchema = z.object({
  turnId: z.string(),
  sessionId: z.string(),
  boxId: z.string(),
  snapshots: z.array(z.object({ storageKey: z.string() })),
});
const RestoreDownloadsSchema = z.object({
  reply: z.object({ type: z.literal("RestoreDownloads"), packs: z.array(z.object({ packDigest: z.string() })) }),
});

type Request = z.infer<typeof SnapshotRequestSchema>;

const packKey = (packDigest: string): string => `${TENANT_ID}/packs/${packDigest}`;

let roots = 0;

const snapshotPacks = (
  request: Request,
  written: string[],
  reused: string[],
): { message: Record<string, unknown>; manifest: string; root: Placement } => {
  roots += 1;
  const manifest = `${" ".repeat(roots)}${JSON.stringify({ entries: [] })}`;
  const digest = sha256(manifest);
  const root = { digest, packDigest: digest, offset: 0, length: manifest.length };
  const chunks = written.map((packDigest) => ({
    digest: sha256(`chunk of ${packDigest}`),
    packDigest,
    offset: 0,
    length: CHUNK_BYTES,
  }));
  const message = {
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: 1,
    packs: [
      ...written.map((packDigest) => ({ packDigest, sizeBytes: CHUNK_BYTES })),
      { packDigest: digest, sizeBytes: manifest.length },
    ],
    chunks: [...chunks, root],
    reusedPackDigests: reused,
  };
  return { message, manifest, root };
};

const answers = async (
  world: World,
  host: Host,
  request: Request,
  written: string[],
  reused: string[],
  uploads = true,
): Promise<void> => {
  const { message, manifest, root } = snapshotPacks(request, written, reused);
  await host.says(message as never);
  if (uploads) for (const packDigest of written) await world.store.put(packKey(packDigest), "pack");
  await world.store.put(packKey(root.packDigest), manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
  await host.says({
    type: "SnapshotDone",
    snapshotId: request.snapshotId,
    uploadedBytes: written.length * CHUNK_BYTES,
    chunkCount: written.length + 1,
  });
};

const startsStored = async (
  world: World,
  host: Host,
  name: string,
  written: string[],
  reused: string[] = [],
): Promise<{ sessionId: string; storageKey: string }> => {
  const session = await world.startSession({ prompt: `build ${name}`, tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const request = snapshotAsked(host, session.sessionId);
  await answers(world, host, request, written, reused);
  return { sessionId: session.sessionId, storageKey: request.storageKey };
};

const states = async (world: World, sessionId: string): Promise<string[]> =>
  SnapshotsSchema.parse(await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId })).snapshots.map(
    (snapshot) => snapshot.outcome.state,
  );

const cleanupSteps = async (world: World): Promise<number> => {
  let steps = 0;
  for (let ms = await world.alarmStep(); ms !== null; ms = await world.alarmStep()) steps += 1;
  return steps;
};

const releasesBoxes = async (host: Host): Promise<void> => {
  while (host.received("BoxTeardown").length > 0) {
    const teardown = z.object({ sessionId: z.string(), boxId: z.string() }).parse(host.take("BoxTeardown"));
    await host.says({ type: "BoxGone", sessionId: teardown.sessionId, boxId: teardown.boxId });
  }
};

test("a SnapshotPacks part and a SnapshotDone each stay within the budget on a restarted tenant of 1400 snapshots and 40000 packs", {
  timeout: 600_000,
}, async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const live = await startsStored(world, host, "the live tree", [sha256("live pack")]);
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
    const packs = Array.from({ length: 29 }, (_, pack) => sha256(`seeded ${at} pack ${pack}`));
    await world.store.put(`${storageKey}.packs`, JSON.stringify(packs));
  }
  const session = await world.startSession({ prompt: "build the measured tree", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const request = snapshotAsked(host, session.sessionId);
  const written = Array.from({ length: 30 }, (_, pack) => sha256(`measured pack ${pack}`));
  const { message, manifest, root } = snapshotPacks(request, written, [sha256("seeded 0 pack 0")]);

  const packsMs = await world.coldMs("hostMessage", { tenantId: TENANT_ID, hostId: host.hostId, message });
  for (const packDigest of written) await world.store.put(packKey(packDigest), "pack");
  await world.store.put(packKey(sha256("seeded 0 pack 0")), "pack");
  await world.store.put(packKey(root.packDigest), manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
  const doneMs = await world.coldMs("hostMessage", {
    tenantId: TENANT_ID,
    hostId: host.hostId,
    message: { type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 0, chunkCount: 31 },
  });

  console.log(`SnapshotPacks ${packsMs.toFixed(2)} ms, SnapshotDone ${doneMs.toFixed(2)} ms after a restart`);
  assert.deepEqual(await states(world, session.sessionId), ["Stored"]);
  assert.ok(packsMs <= BUDGET_MS, `the SnapshotPacks part took ${packsMs.toFixed(2)} ms`);
  assert.ok(doneMs <= BUDGET_MS, `the SnapshotDone took ${doneMs.toFixed(2)} ms`);
});

test("a SnapshotDone naming 3000 reused packs and 30 written ones stays within the budget on a restarted tenant", {
  timeout: 600_000,
}, async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.holdsAgentCredentials();
  const reused = Array.from({ length: 3000 }, (_, pack) => sha256(`reused pack ${pack}`));
  const session = await world.startSession({ prompt: "build the wide tree", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const first = snapshotAsked(host, session.sessionId);
  for (let part = 0; part < reused.length / 500; part++) {
    const packs = reused.slice(part * 500, (part + 1) * 500);
    await host.says({
      type: "SnapshotPacks",
      snapshotId: first.snapshotId,
      part: part + 1,
      packs: packs.map((packDigest) => ({ packDigest, sizeBytes: CHUNK_BYTES })),
      chunks: packs.map((packDigest) => ({
        digest: sha256(`chunk of ${packDigest}`),
        packDigest,
        offset: 0,
        length: CHUNK_BYTES,
      })),
      reusedPackDigests: [],
    });
    for (const packDigest of packs) await world.store.put(packKey(packDigest), "pack");
  }
  const base = snapshotPacks(first, [], []);
  await host.says({ ...base.message, part: 7 } as never);
  await world.store.put(packKey(base.root.packDigest), base.manifest);
  await world.store.put(first.storageKey, JSON.stringify({ manifest: [base.root] }));
  await host.says({ type: "SnapshotDone", snapshotId: first.snapshotId, uploadedBytes: 0, chunkCount: 3001 });
  assert.deepEqual(await states(world, session.sessionId), ["Stored"]);

  await world.sendTurn(session.sessionId, "change thirty files");
  const next = host.takeOffer();
  await host.claims(next);
  await host.completes(next);
  const request = snapshotAsked(host, session.sessionId);
  for (let part = 0; part < reused.length / 500; part++) {
    await host.says({
      type: "SnapshotPacks",
      snapshotId: request.snapshotId,
      part: part + 1,
      packs: [],
      chunks: [],
      reusedPackDigests: reused.slice(part * 500, (part + 1) * 500),
    });
  }
  const written = Array.from({ length: 30 }, (_, pack) => sha256(`written pack ${pack}`));
  const last = snapshotPacks(request, written, []);
  await host.says({ ...last.message, part: 7 } as never);
  for (const packDigest of written) await world.store.put(packKey(packDigest), "pack");
  await world.store.put(packKey(last.root.packDigest), last.manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [last.root] }));
  const heads = t.mock.method(world.store, "head");
  const doneMs = await world.coldMs("hostMessage", {
    tenantId: TENANT_ID,
    hostId: host.hostId,
    message: { type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 0, chunkCount: 3031 },
  });

  console.log(`SnapshotDone of 3031 packs ${doneMs.toFixed(2)} ms after a restart, ${heads.mock.callCount()} HEADs`);
  assert.deepEqual(await states(world, session.sessionId), ["Stored"]);
  assert.equal(heads.mock.callCount(), 31, "only the written packs and the root are checked");
  assert.ok(doneMs <= BUDGET_MS, `the SnapshotDone took ${doneMs.toFixed(2)} ms`);
});

test("a pack shared with another session survives a reset between a store and its collection, the next store and a cleanup run", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.holdsAgentCredentials();
  const shared = sha256("shared pack");
  await startsStored(world, host, "the other tree", [shared]);
  const session = await startsStored(world, host, "the sharing tree", [], [shared]);

  await world.sendTurn(session.sessionId, "change one file");
  const second = host.takeOffer();
  await host.claims(second);
  await host.completes(second);
  const collected = snapshotAsked(host, session.sessionId);
  world.store.failure = { operation: "delete", prefix: session.storageKey, error: new Error("the tenant reset") };
  await answers(world, host, collected, [sha256("second pack")], []).catch(() => undefined);
  world.store.failure = null;
  await world.restartTenant();

  await world.sendTurn(session.sessionId, "change another file");
  const third = host.takeOffer();
  await host.claims(third);
  await host.completes(third);
  await answers(world, host, snapshotAsked(host, session.sessionId), [sha256("third pack")], []);
  await world.tick(61 * MINUTE_MS);
  await world.tick(10 * MINUTE_MS);
  assert.ok((await cleanupSteps(world)) > 0, "the collection starts a cleanup run");

  assert.equal(await world.store.head(session.storageKey), null, "the third store collects the first snapshot");
  assert.notEqual(await world.store.head(packKey(shared)), null, "the other session's pack stays");
});

test("a SnapshotDone whose presigned pack object storage lacks is refused, never stored", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "build the unsent tree", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  await answers(world, host, snapshotAsked(host, session.sessionId), [sha256("unsent pack")], [], false);

  assert.deepEqual(await states(world, session.sessionId), ["Failed"]);
});

test("a SnapshotDone reusing a pack object storage no longer holds is refused, though a stored snapshot names it", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const lost = sha256("lost pack");
  await startsStored(world, host, "the named tree", [lost]);
  await world.store.delete(packKey(lost));
  const session = await world.startSession({ prompt: "reuse the lost pack", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  await answers(world, host, snapshotAsked(host, session.sessionId), [], [lost]);

  assert.deepEqual(await states(world, session.sessionId), ["Failed"]);
});

test("a corrupt pack list of the previous snapshot does not refuse the next snapshot, which checks its reused packs instead", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.holdsAgentCredentials();
  const kept = sha256("kept pack");
  const session = await startsStored(world, host, "the corrupted tree", [kept]);
  await world.store.put(`${session.storageKey}.packs`, "not a pack list");
  await world.restartTenant();

  await world.sendTurn(session.sessionId, "change one file");
  const next = host.takeOffer();
  await host.claims(next);
  await host.completes(next);
  await answers(world, host, snapshotAsked(host, session.sessionId), [], [kept]);

  assert.deepEqual((await states(world, session.sessionId)).at(-1), "Stored");
});

test("a storage failure reading the previous pack list fails only that snapshot, and the next one stores and collects", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.holdsAgentCredentials();
  const kept = sha256("kept pack");
  const session = await startsStored(world, host, "the unread tree", [kept]);
  await world.restartTenant();

  await world.sendTurn(session.sessionId, "change one file");
  const failing = host.takeOffer();
  await host.claims(failing);
  await host.completes(failing);
  world.store.failure = { operation: "get", prefix: `${session.storageKey}.packs`, error: new Error("R2 is down") };
  const failed = snapshotAsked(host, session.sessionId);
  await answers(world, host, failed, [], [kept]);
  world.store.failure = null;
  assert.deepEqual(await states(world, session.sessionId), ["Stored", "Failed"]);
  assert.equal(
    world.tenantSql().exec("SELECT 1 FROM snapshot_requests WHERE snapshot_id = ?", failed.snapshotId).toArray().length,
    0,
    "the failed snapshot closes its request",
  );

  const request = snapshotAsked(host, session.sessionId);
  await answers(world, host, request, [], [kept]);

  assert.equal((await states(world, session.sessionId)).at(-1), "Stored");
  assert.equal(await world.store.head(session.storageKey), null, "the next store collects the first snapshot");
});

test("with two open requests, the first store keeps the previous snapshot until the second reuses its pack, stores and restores", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.holdsAgentCredentials();
  const kept = sha256("kept pack");
  const other = await startsStored(world, host, "the other tree", [sha256("other pack")]);
  const session = await startsStored(world, host, "the previous tree", [kept]);
  await world.tick(61 * MINUTE_MS);

  await world.sendTurn(session.sessionId, "fail once");
  const failing = host.takeOffer();
  await host.claims(failing);
  await host.says({
    type: "TurnFailed",
    turnId: failing.turnId,
    reason: "HarnessReportedError",
    detail: "the harness reported an error",
    failedAt: new Date(Date.now()).toISOString(),
  });
  const first = snapshotAsked(host, session.sessionId);
  await world.sendTurn(session.sessionId, "change one file");
  const next = host.takeOffer();
  await host.claims(next);
  await host.completes(next);
  const second = snapshotAsked(host, session.sessionId);

  await answers(world, host, first, [sha256("first pack")], []);
  await world.call("archiveSession", { tenantId: TENANT_ID, sessionId: other.sessionId, now: Date.now() });
  await world.tick(10 * MINUTE_MS);
  assert.ok((await cleanupSteps(world)) > 0, "the archive starts a cleanup run");
  assert.notEqual(await world.store.head(packKey(kept)), null, "the previous snapshot's pack stays");
  await answers(world, host, second, [], [kept]);

  assert.notEqual(await world.store.head(packKey(kept)), null, "the reused pack is in object storage");
  await releasesBoxes(host);
  await world.sendTurn(session.sessionId, "restore me");
  const restoring = OfferSchema.parse(host.take("TurnOffer"));
  assert.deepEqual(
    restoring.snapshots.map((snapshot) => snapshot.storageKey),
    [second.storageKey],
  );
  const downloads = RestoreDownloadsSchema.parse(
    await host.says({
      type: "RestoreChunks",
      turnId: restoring.turnId,
      part: 1,
      chunks: [{ digest: sha256(`chunk of ${kept}`), packDigest: kept, offset: 0, length: CHUNK_BYTES }],
    }),
  );
  assert.deepEqual(
    downloads.reply.packs.map((pack) => pack.packDigest),
    [kept],
  );
});

const prebuildLayer = async (world: World, host: Host): Promise<{ storageKey: string; pack: string }> => {
  await world.startPrebuild();
  const build = host.takeOffer();
  await host.claims(build);
  await host.completes(build);
  const request = snapshotAsked(host, build.sessionId);
  const pack = sha256("layer pack");
  await answers(world, host, request, [pack], []);
  await releasesBoxes(host);
  await world.holdsAgentCredentials();
  return { storageKey: request.storageKey, pack };
};

const prebuildSessionId = (world: World): string =>
  z
    .object({ session_id: z.string() })
    .parse(world.tenantSql().exec("SELECT session_id FROM prebuild_sessions").toArray()[0]).session_id;

const consumerFailsSnapshot = async (world: World, host: Host): Promise<{ sessionId: string; boxId: string }> => {
  const session = await world.startSession({ prompt: "start from the prebuild", tags: [] });
  const offer = OfferSchema.parse(host.take("TurnOffer"));
  await host.claims(offer as never);
  await host.says({
    type: "TurnFailed",
    turnId: offer.turnId,
    reason: "HarnessReportedError",
    detail: "the harness reported an error",
    failedAt: new Date(Date.now()).toISOString(),
  });
  const request = snapshotAsked(host, session.sessionId);
  await host.says({
    type: "SnapshotFailed",
    snapshotId: request.snapshotId,
    reason: "UploadRejected",
    detail: "object storage refused the upload",
    failedAt: new Date(Date.now()).toISOString(),
  });
  return { sessionId: session.sessionId, boxId: offer.boxId };
};

test("a prebuild stays while a consumer has an open snapshot request and no snapshot", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const layer = await prebuildLayer(world, host);
  const session = await world.startSession({ prompt: "start from the prebuild", tags: [] });
  const offer = OfferSchema.parse(host.take("TurnOffer"));
  await host.claims(offer as never);
  await host.completes(offer as never);
  snapshotAsked(host, session.sessionId);
  await world.restartTenant();

  await world.call("archiveSession", { tenantId: TENANT_ID, sessionId: prebuildSessionId(world), now: Date.now() });
  assert.notEqual(await world.store.head(layer.storageKey), null, "the layer stays for the open request");
  assert.notEqual(await world.store.head(packKey(layer.pack)), null);
});

test("a prebuild stays while a consumer is idle, holding its box, with no snapshot", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const layer = await prebuildLayer(world, host);
  const consumer = await consumerFailsSnapshot(world, host);
  assert.equal((await world.session(consumer.sessionId)).state, "Idle");
  await world.restartTenant();

  await world.call("archiveSession", { tenantId: TENANT_ID, sessionId: prebuildSessionId(world), now: Date.now() });
  assert.notEqual(await world.store.head(layer.storageKey), null, "the layer stays for the idle box");
});

test("a prebuild goes once its only consumer without a snapshot has lost its box", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const layer = await prebuildLayer(world, host);
  const consumer = await consumerFailsSnapshot(world, host);
  await host.says({ type: "BoxGone", sessionId: consumer.sessionId, boxId: consumer.boxId });
  assert.equal((await world.session(consumer.sessionId)).state, "Stopped");
  await world.restartTenant();

  await world.call("archiveSession", { tenantId: TENANT_ID, sessionId: prebuildSessionId(world), now: Date.now() });
  assert.equal(await world.store.head(layer.storageKey), null, "the layer goes with no box left to restore into");
});
