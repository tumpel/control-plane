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
  snapshotAsked,
  TENANT_ID,
  tree,
  uploadsChunks,
} from "./harness/snapshot-chunks.ts";
import type { Host, World } from "./harness/world.ts";

const LARGE = 100_000;
const ROWS_PER_STORED_SNAPSHOT = 20;
const ROWS_PER_FORK = 21;
const CONCURRENT_SESSIONS = 4;
const CONCURRENT_CHUNKS = 20_000;

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

const storesRoot = async (
  world: World,
  host: Host,
  request: { snapshotId: string; storageKey: string },
  chunks: Placement[],
  part: number,
): Promise<Placement> => {
  const root = await putsRoot(world.store, request.storageKey, chunks, 0);
  await host.says({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part,
    packs: [{ packDigest: root.packDigest, sizeBytes: root.length }],
    chunks: [root],
    reusedPackDigests: [],
  });
  return root;
};

const putsRoot = async (
  store: R2Bucket,
  storageKey: string,
  chunks: Placement[],
  padding: number,
): Promise<Placement> => {
  const json = JSON.stringify({
    entries: [
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

const storesSnapshot = async (
  world: World,
  host: Host,
  sessionId: string,
  chunks: Placement[],
): Promise<{ storageKey: string; root: Placement }> => {
  const request = snapshotAsked(host, sessionId);
  await uploadsChunks(world, host, request.snapshotId, chunks);
  const root = await storesRoot(world, host, request, chunks, parts(chunks).length + 1);
  await host.says({
    type: "SnapshotDone",
    snapshotId: request.snapshotId,
    uploadedBytes: chunks.length * CHUNK_BYTES,
    chunkCount: chunks.length,
  });
  return { storageKey: request.storageKey, root };
};

const reusesPacks = async (host: Host, snapshotId: string, chunks: Placement[]): Promise<void> => {
  await host.says({
    type: "SnapshotPacks",
    snapshotId,
    part: 1,
    packs: [],
    chunks: [],
    reusedPackDigests: [...new Set(chunks.map((chunk) => chunk.packDigest))],
  });
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

test("a stored snapshot of 100000 chunks writes the rows of a one-chunk snapshot, and its archive frees its root", async () => {
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

test("sessions that snapshot at once read no object storage for their chunk asks, however many parts they send", async () => {
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
        assert.deepEqual(answer.reply.held, []);
      }
    }
    const gets = world.store.gets - before;
    assert.equal(
      gets,
      0,
      `${CONCURRENT_SESSIONS} sessions sending ${count} parts each read object storage ${gets} times`,
    );
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
    await storesRoot(world, host, request, chunks, parts(chunks).length + 1);
    world.store.failure = {
      operation: "get",
      prefix: request.storageKey,
      error: new Error("object storage timed out"),
    };
    await host.says({
      type: "SnapshotDone",
      snapshotId: request.snapshotId,
      uploadedBytes: chunks.length * CHUNK_BYTES,
      chunkCount: chunks.length,
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
    await reusesPacks(host, request.snapshotId, chunks);
    await storesRoot(world, host, request, chunks, 2);
    await host.says({
      type: "SnapshotDone",
      snapshotId: request.snapshotId,
      uploadedBytes: 0,
      chunkCount: chunks.length,
    });

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
    await reusesPacks(host, request.snapshotId, chunks);
    await storesRoot(world, host, request, chunks, 2);
    await host.says({
      type: "SnapshotDone",
      snapshotId: request.snapshotId,
      uploadedBytes: 0,
      chunkCount: chunks.length,
    });

    const { snapshots } = SnapshotsSchema.parse(
      await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: session.sessionId }),
    );
    assert.match(JSON.stringify(snapshots.at(-1)?.outcome), new RegExp(`names pack ${packDigest}`));
  });
});

test("a snapshot whose root places its manifest in a pack no part named is not stored, naming the pack", async () => {
  await inWorld(async (world, host) => {
    const chunks = tree(DIGESTS_PER_PART, "unnamed manifest");
    const session = await world.startSession({ prompt: "build without naming the manifest pack", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    const request = snapshotAsked(host, session.sessionId);
    await uploadsChunks(world, host, request.snapshotId, chunks);
    const root = await putsRoot(world.store, request.storageKey, chunks, 0);
    await host.says({
      type: "SnapshotDone",
      snapshotId: request.snapshotId,
      uploadedBytes: chunks.length * CHUNK_BYTES,
      chunkCount: chunks.length,
    });

    const { snapshots } = SnapshotsSchema.parse(
      await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: session.sessionId }),
    );
    assert.equal(snapshots[0]?.outcome.state, "Failed");
    assert.equal(snapshots[0]?.outcome.reason, "UploadRejected");
    assert.match(
      snapshots[0]?.outcome.detail ?? "",
      new RegExp(`places its manifest in pack ${root.packDigest}, which no SnapshotPacks part named`),
    );
    assert.notEqual(
      await world.store.get(`${request.storageKey}.packs`),
      null,
      "a rejected snapshot lists its packs too",
    );
  });
});

test("a snapshot of 3 new packs and 2 reused ones lists all 5 and its manifest pack in its pack list without reading its manifest", async () => {
  await inWorld(async (world, host) => {
    const base = tree(2 * DIGESTS_PER_PART, "base");
    const fresh = tree(3 * DIGESTS_PER_PART, "fresh");
    const reused = [...new Set(base.map((chunk) => chunk.packDigest))];
    const written = [...new Set(fresh.map((chunk) => chunk.packDigest))];
    await world.holdsAgentCredentials();
    const session = await world.startSession({ prompt: "build the base", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    await storesSnapshot(world, host, session.sessionId, base);

    await world.sendTurn(session.sessionId, "add to the base");
    const next = host.takeOffer();
    await host.claims(next);
    await host.completes(next);
    const request = snapshotAsked(host, session.sessionId);
    for (const [at, part] of parts(fresh).entries()) {
      const answer = PackUploadsSchema.parse(
        await host.says({
          type: "SnapshotPacks",
          snapshotId: request.snapshotId,
          part: at + 1,
          packs: [{ packDigest: part[0]?.packDigest ?? "", sizeBytes: part.length * CHUNK_BYTES }],
          chunks: part,
          reusedPackDigests: at === 0 ? reused : [],
        }),
      );
      for (const upload of answer.reply.uploads)
        await world.store.put(`${TENANT_ID}/packs/${upload.packDigest}`, "pack");
    }
    const root = await storesRoot(world, host, request, [...base, ...fresh], parts(fresh).length + 1);
    world.store.failure = {
      operation: "get",
      prefix: `${TENANT_ID}/packs/`,
      error: new Error("SnapshotDone read a pack of the manifest"),
    };
    await host.says({
      type: "SnapshotDone",
      snapshotId: request.snapshotId,
      uploadedBytes: fresh.length * CHUNK_BYTES,
      chunkCount: base.length + fresh.length,
    });
    world.store.failure = null;

    const { snapshots } = SnapshotsSchema.parse(
      await world.call("listSnapshots", { tenantId: TENANT_ID, sessionId: session.sessionId }),
    );
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.outcome.state),
      ["Stored"],
    );
    const listed = await world.store.get(`${request.storageKey}.packs`);
    assert.deepEqual(JSON.parse((await listed?.text()) ?? "[]"), [...reused, ...written, root.packDigest].sort());
    for (const packDigest of reused) {
      assert.notEqual(
        await world.store.get(`${TENANT_ID}/packs/${packDigest}`),
        null,
        `reused pack ${packDigest} is kept`,
      );
    }
  });
});
