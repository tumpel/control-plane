import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import type { R2Bucket } from "./harness/runtime.ts";
import {
  CHUNK_BYTES,
  DIGESTS_PER_PART,
  failsSnapshot,
  inWorld,
  PackUploadsSchema,
  type Placement,
  parts,
  type SnapshotRequestSchema,
  sha256,
  snapshotAsked,
  TENANT_ID,
  tree,
  uploadsChunks,
} from "./harness/snapshot-chunks.ts";
import { type Host, UNMETERED, World } from "./harness/world.ts";

const LARGE = 100_000;
const ROWS_PER_STORED_SNAPSHOT = 20;
const ROWS_PER_FORK = 21;
const CONCURRENT_SESSIONS = 4;
const CONCURRENT_CHUNKS = 20_000;
const GETS_PER_MANIFEST = 2;
const LARGEST_RESTORABLE = 500_000;
const OVER_CAP_ROOT_PLACEMENTS = 700_000;

type ManifestsModule = {
  MAX_INDEX_BYTES: number;
  SnapshotManifests: new () => {
    index(
      store: R2Bucket,
      tenantId: string,
      storageKey: string,
    ): Promise<
      | { kind: "Read"; value: { bytes: number; find(digest: string): Placement | undefined } }
      | { kind: "Gone" | "Unreadable"; detail: string }
    >;
  };
};

const RestoreDownloadsSchema = z.object({
  reply: z.object({ type: z.literal("RestoreDownloads"), packs: z.array(z.object({ packDigest: z.string() })) }),
});
const ChunksHeldSchema = z.object({
  reply: z.object({ type: z.literal("SnapshotChunksHeld"), held: z.array(z.object({ digest: z.string() })) }),
});
const SnapshotsSchema = z.object({
  snapshots: z.array(
    z.object({
      outcome: z.object({ state: z.string(), reason: z.string().optional(), detail: z.string().optional() }),
    }),
  ),
});
const OfferedSnapshotsSchema = z.object({
  turnId: z.string(),
  snapshots: z.array(z.object({ storageKey: z.string() })),
});

const storesRoot = (
  world: World,
  storageKey: string,
  chunks: Placement[],
  unknownEntries: object[] = [],
): Promise<Placement> => putsRoot(world.store, storageKey, chunks, unknownEntries, 0);

const putsRoot = async (
  store: R2Bucket,
  storageKey: string,
  chunks: Placement[],
  unknownEntries: object[],
  padding: number,
): Promise<Placement> => {
  const json = JSON.stringify({
    entries: [
      ...unknownEntries,
      {
        kind: "File",
        path: "tree",
        mode: 420,
        uid: 0,
        gid: 0,
        mtimeSeconds: 0,
        mtimeNanos: 0,
        sizeBytes: chunks.length * CHUNK_BYTES,
        chunks,
      },
    ],
  });
  const manifest = Buffer.alloc(padding + Buffer.byteLength(json), " ");
  manifest.write(json, padding);
  const digest = createHash("sha256").update(manifest).digest("hex");
  await store.put(`${TENANT_ID}/packs/${digest}`, manifest);
  const root = { digest, packDigest: digest, offset: 0, length: manifest.byteLength };
  await store.put(storageKey, JSON.stringify({ manifest: [root] }));
  return root;
};

const insertsSnapshot = (
  world: World,
  snapshotId: string,
  request: z.infer<typeof SnapshotRequestSchema>,
  storageKey: string,
  sessionId = request.sessionId,
): void => {
  world
    .tenantSql()
    .exec(
      "INSERT INTO snapshots (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)",
      snapshotId,
      sessionId,
      request.boxId,
      request.turnId,
      storageKey,
      Date.now(),
      Date.now(),
    );
};

const storesSnapshot = async (
  world: World,
  host: Host,
  sessionId: string,
  chunks: Placement[],
): Promise<{ storageKey: string; root: Placement }> => {
  const request = snapshotAsked(host, sessionId);
  await uploadsChunks(world, host, request.snapshotId, chunks);
  const root = await storesRoot(world, request.storageKey, chunks);
  await host.says({
    type: "SnapshotDone",
    chunkCount: chunks.length,
    snapshotId: request.snapshotId,
    uploadedBytes: chunks.length * CHUNK_BYTES,
  });
  return { storageKey: request.storageKey, root };
};

const rowsOfStoredSnapshot = (chunks: Placement[]): Promise<number> =>
  inWorld(async (world, host) => {
    const session = await world.startSession({ prompt: "build the tree", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    const before = world.tenantRowsWritten();
    const { storageKey } = await storesSnapshot(world, host, session.sessionId, chunks);
    const written = world.tenantRowsWritten() - before;

    await world.call("archiveSession", { tenantId: TENANT_ID, sessionId: session.sessionId, now: Date.now() });
    assert.equal(await world.store.get(storageKey), null, "the archive frees the root");
    const packs = new Set(chunks.map((chunk) => chunk.packDigest));
    for (const packDigest of packs) {
      assert.equal(await world.store.get(`${TENANT_ID}/packs/${packDigest}`), null, "no snapshot holds the pack");
    }
    return written;
  });

const rowsOfFork = (chunks: Placement[]): Promise<number> =>
  inWorld(async (world, host) => {
    await world.startPrebuild();
    const build = host.takeOffer();
    await host.claims(build);
    await host.completes(build);
    const layer = await storesSnapshot(world, host, build.sessionId, chunks);
    await world.holdsAgentCredentials();

    const before = world.tenantRowsWritten();
    await world.startSession({ prompt: "start from the prebuild", tags: [] });
    const offer = OfferedSnapshotsSchema.parse(host.take("TurnOffer"));
    assert.deepEqual(
      offer.snapshots.map((snapshot) => snapshot.storageKey),
      [layer.storageKey],
    );
    const restored = [[layer.root], ...parts(chunks)];
    for (const [at, part] of restored.entries()) {
      const downloads = RestoreDownloadsSchema.parse(
        await host.says({ type: "RestoreChunks", turnId: offer.turnId, part: at + 1, chunks: part }),
      );
      assert.deepEqual(
        downloads.reply.packs.map((pack) => pack.packDigest),
        [part[0]?.packDigest],
      );
    }
    return world.tenantRowsWritten() - before;
  });

test("a stored snapshot of 100000 chunks writes the rows of a one-chunk snapshot, and its archive frees every pack", async () => {
  const large = await rowsOfStoredSnapshot(tree(LARGE));
  const small = await rowsOfStoredSnapshot(tree(1));
  assert.equal(large, small);
  assert.ok(small <= ROWS_PER_STORED_SNAPSHOT, `a stored snapshot wrote ${small} rows`);
});

test("a session forked from a prebuild of 100000 chunks writes the rows of a fork from a one-chunk prebuild", async () => {
  const large = await rowsOfFork(tree(LARGE));
  const small = await rowsOfFork(tree(1));
  assert.equal(large, small);
  assert.ok(small <= ROWS_PER_FORK, `a fork wrote ${small} rows`);
});

test("sessions that snapshot at once read each manifest once, however many parts they send", async () => {
  await inWorld(async (world, host) => {
    await world.holdsAgentCredentials();
    const sessions: { sessionId: string; chunks: Placement[]; snapshotId: string }[] = [];
    for (let at = 0; at < CONCURRENT_SESSIONS; at++) {
      const chunks = tree(CONCURRENT_CHUNKS, `session ${at}`);
      const session = await world.startSession({ prompt: `build tree ${at}`, tags: [] });
      const offer = host.takeOffer();
      await host.claims(offer);
      await host.completes(offer);
      await storesSnapshot(world, host, session.sessionId, chunks);
      sessions.push({ sessionId: session.sessionId, chunks, snapshotId: "" });
    }
    for (const session of sessions) {
      await world.sendTurn(session.sessionId, "change the tree");
      const offer = host.takeOffer();
      await host.claims(offer);
      await host.completes(offer);
      session.snapshotId = snapshotAsked(host, session.sessionId).snapshotId;
    }
    const before = world.store.gets;
    const count = Math.ceil(CONCURRENT_CHUNKS / DIGESTS_PER_PART);
    for (let part = 0; part < count; part++) {
      for (const session of sessions) {
        const digests = (parts(session.chunks)[part] ?? []).map((chunk) => chunk.digest);
        const answer = ChunksHeldSchema.parse(
          await host.says({ type: "SnapshotChunks", snapshotId: session.snapshotId, part: part + 1, digests }),
        );
        assert.equal(answer.reply.held.length, digests.length);
      }
    }
    const gets = world.store.gets - before;
    assert.ok(
      gets <= CONCURRENT_SESSIONS * GETS_PER_MANIFEST,
      `${CONCURRENT_SESSIONS} sessions sending ${count} parts each read object storage ${gets} times`,
    );
  });
});

test("a manifest the control plane cannot read is rejected at SnapshotDone, and one stored before keeps every pack it names", async () => {
  await inWorld(async (world, host) => {
    const chunks = tree(2_000, "newer host");
    const unknownEntry = {
      kind: "Socket",
      path: "run/agent.sock",
      mode: 420,
      uid: 0,
      gid: 0,
      mtimeSeconds: 0,
      mtimeNanos: 0,
    };
    const session = await world.startSession({ prompt: "build with a newer host", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    const request = snapshotAsked(host, session.sessionId);
    const storedBefore = `${TENANT_ID}/${session.sessionId}/snapshots/stored-before`;
    const manifestPack = (await storesRoot(world, storedBefore, chunks, [unknownEntry])).packDigest;
    for (const packDigest of new Set(chunks.map((chunk) => chunk.packDigest))) {
      await world.store.put(`${TENANT_ID}/packs/${packDigest}`, "pack");
    }
    insertsSnapshot(world, "stored-before", request, storedBefore);
    await uploadsChunks(world, host, request.snapshotId, chunks);

    await storesRoot(world, request.storageKey, chunks, [unknownEntry]);
    await host.says({
      type: "SnapshotDone",
      chunkCount: chunks.length,
      snapshotId: request.snapshotId,
      uploadedBytes: chunks.length * CHUNK_BYTES,
    });

    const { snapshots } = SnapshotsSchema.parse(
      await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: session.sessionId }),
    );
    const rejected = snapshots.find((snapshot) => snapshot.outcome.state === "Failed");
    assert.equal(rejected?.outcome.reason, "UploadRejected");
    assert.match(rejected?.outcome.detail ?? "", /cannot read/);
    for (const packDigest of new Set([manifestPack, ...chunks.map((chunk) => chunk.packDigest)])) {
      assert.notEqual(await world.store.get(`${TENANT_ID}/packs/${packDigest}`), null, `pack ${packDigest} is kept`);
    }
  });
});

test("an object storage failure while SnapshotDone reads the root fails only that snapshot, and the next one is stored", async () => {
  await inWorld(async (world, host) => {
    const chunks = tree(DIGESTS_PER_PART, "flaky storage");
    const session = await world.startSession({ prompt: "build while storage fails", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    const request = snapshotAsked(host, session.sessionId);
    await uploadsChunks(world, host, request.snapshotId, chunks);
    await storesRoot(world, request.storageKey, chunks);
    world.store.failure = {
      operation: "get",
      prefix: request.storageKey,
      error: new Error("object storage timed out"),
    };
    await host.says({
      type: "SnapshotDone",
      chunkCount: chunks.length,
      snapshotId: request.snapshotId,
      uploadedBytes: chunks.length * CHUNK_BYTES,
    });
    world.store.failure = null;

    const failed = SnapshotsSchema.parse(
      await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: session.sessionId }),
    );
    assert.equal(failed.snapshots.length, 1);
    assert.equal(failed.snapshots[0]?.outcome.reason, "UploadRejected");
    assert.match(failed.snapshots[0]?.outcome.detail ?? "", /object storage timed out/);

    const other = await world.startSession({ prompt: "build after the failure", tags: [] });
    const next = host.takeOffer();
    await host.claims(next);
    await host.completes(next);
    await storesSnapshot(world, host, other.sessionId, chunks);
    const stored = SnapshotsSchema.parse(
      await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: other.sessionId }),
    );
    assert.ok(stored.snapshots.some((snapshot) => snapshot.outcome.state === "Stored"));
  });
});

test("a snapshot that reuses a pack another session's archive frees while it is in flight is rejected, naming the pack", async () => {
  await inWorld(async (world, host) => {
    const shared = tree(DIGESTS_PER_PART, "shared");
    const sharedPack = shared[0]?.packDigest ?? "";
    const first = await world.startSession({ prompt: "build the shared tree", tags: [] });
    const firstOffer = host.takeOffer();
    await host.claims(firstOffer);
    await host.completes(firstOffer);
    await storesSnapshot(world, host, first.sessionId, shared);
    await world.passes(2 * 60_000);

    const second = await world.startSession({ prompt: "build on the shared tree", tags: [] });
    const secondOffer = host.takeOffer();
    await host.claims(secondOffer);
    await host.completes(secondOffer);
    const request = snapshotAsked(host, second.sessionId);
    const reused = PackUploadsSchema.parse(
      await host.says({
        type: "SnapshotPacks",
        reusedPackDigests: [],
        snapshotId: request.snapshotId,
        part: 1,
        packs: [{ packDigest: sharedPack, sizeBytes: shared.length * CHUNK_BYTES }],
        chunks: shared,
      }),
    );
    assert.deepEqual(reused.reply.uploads, [], "the first session's live snapshot names the pack");

    await world.call("archiveSession", { tenantId: TENANT_ID, sessionId: first.sessionId, now: Date.now() });
    assert.equal(await world.store.get(`${TENANT_ID}/packs/${sharedPack}`), null, "the archive freed the pack");
    await storesRoot(world, request.storageKey, shared);
    await host.says({
      type: "SnapshotDone",
      chunkCount: shared.length,
      snapshotId: request.snapshotId,
      uploadedBytes: shared.length * CHUNK_BYTES,
    });

    const { snapshots } = SnapshotsSchema.parse(
      await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: second.sessionId }),
    );
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.outcome.state, "Failed");
    assert.equal(snapshots[0]?.outcome.reason, "UploadRejected");
    assert.match(snapshots[0]?.outcome.detail ?? "", new RegExp(sharedPack));
  });
});

test("a snapshot that reuses packs an unstored snapshot of the session uploaded is stored", async () => {
  await inWorld(async (world, host) => {
    await world.holdsAgentCredentials();
    const chunks = tree(DIGESTS_PER_PART, "uploaded before the host went offline");
    const session = await world.startSession({ prompt: "build the tree", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    const unstored = snapshotAsked(host, session.sessionId);
    await uploadsChunks(world, host, unstored.snapshotId, chunks);
    await failsSnapshot(host, unstored.snapshotId);

    await world.sendTurn(session.sessionId, "change the tree");
    const next = host.takeOffer();
    await host.claims(next);
    await host.completes(next);
    const request = snapshotAsked(host, session.sessionId);
    await storesRoot(world, request.storageKey, chunks);
    await host.says({ type: "SnapshotDone", chunkCount: 0, snapshotId: request.snapshotId, uploadedBytes: 0 });

    const { snapshots } = SnapshotsSchema.parse(
      await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: session.sessionId }),
    );
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.outcome.state),
      ["Failed", "Stored"],
      JSON.stringify(snapshots),
    );
  });
});

test("a snapshot that reuses a pack an unstored snapshot was granted but never put is rejected, naming the pack", async () => {
  await inWorld(async (world, host) => {
    await world.holdsAgentCredentials();
    const chunks = tree(DIGESTS_PER_PART, "granted before the host went offline");
    const session = await world.startSession({ prompt: "build the tree", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    const unstored = snapshotAsked(host, session.sessionId);
    await uploadsChunks(world, host, unstored.snapshotId, chunks);
    const packDigest = chunks[0]?.packDigest ?? "";
    await world.store.delete(`${TENANT_ID}/packs/${packDigest}`);
    await failsSnapshot(host, unstored.snapshotId);

    await world.sendTurn(session.sessionId, "change the tree");
    const next = host.takeOffer();
    await host.claims(next);
    await host.completes(next);
    const request = snapshotAsked(host, session.sessionId);
    await storesRoot(world, request.storageKey, chunks);
    await host.says({ type: "SnapshotDone", chunkCount: 0, snapshotId: request.snapshotId, uploadedBytes: 0 });

    const { snapshots } = SnapshotsSchema.parse(
      await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: session.sessionId }),
    );
    assert.match(JSON.stringify(snapshots.at(-1)?.outcome), new RegExp(`reuses pack ${packDigest}`));
  });
});

test("a manifest of 500000 chunks loads into an index within the memory the control plane holds", async () => {
  const world = await World.open({ limits: UNMETERED });
  try {
    const chunks = tree(LARGEST_RESTORABLE, "largest");
    const storageKey = `${TENANT_ID}/session/snapshots/largest`;
    await putsRoot(world.store, storageKey, chunks, [], 0);
    const { MAX_INDEX_BYTES, SnapshotManifests }: ManifestsModule = await import(
      new URL("../../src/snapshot-manifests.ts", import.meta.url).href
    );
    const read = await new SnapshotManifests().index(world.store, TENANT_ID, storageKey);
    assert.equal(read.kind, "Read", read.kind === "Read" ? "" : read.detail);
    if (read.kind !== "Read") return;
    assert.ok(read.value.bytes <= MAX_INDEX_BYTES, `the index takes ${read.value.bytes} bytes`);
    const last = chunks.at(-1);
    assert.deepEqual(last === undefined ? undefined : { ...read.value.find(last.digest) }, last);
  } finally {
    await world.close();
  }
});

test("a snapshot root whose own placements would pass the index cap is rejected at SnapshotDone", async () => {
  await inWorld(async (world, host) => {
    const session = await world.startSession({ prompt: "build a root of one-byte chunks", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    const request = snapshotAsked(host, session.sessionId);
    const packDigest = sha256("one-byte pack");
    const manifest = Array.from({ length: OVER_CAP_ROOT_PLACEMENTS }, (_, at) => ({
      digest: sha256("one-byte chunk"),
      packDigest,
      offset: at,
      length: 1,
    }));
    await world.store.put(request.storageKey, JSON.stringify({ manifest }));
    await host.says({
      type: "SnapshotDone",
      chunkCount: 1,
      snapshotId: request.snapshotId,
      uploadedBytes: OVER_CAP_ROOT_PLACEMENTS,
    });

    const { snapshots } = SnapshotsSchema.parse(
      await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: session.sessionId }),
    );
    assert.equal(snapshots[0]?.outcome.state, "Failed");
    assert.match(snapshots[0]?.outcome.detail ?? "", /chunk index would take/);
  });
});
