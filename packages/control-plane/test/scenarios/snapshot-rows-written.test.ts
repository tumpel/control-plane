import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import type { R2Bucket } from "./harness/runtime.ts";
import { type Host, World } from "./harness/world.ts";

const TENANT_ID = "tenant-scenario";
const LARGE = 100_000;
const DIGESTS_PER_PART = 500;
const CHUNK_BYTES = 65_536;
const ROWS_PER_FAILED_SNAPSHOT = 11;
const ROWS_PER_STORED_SNAPSHOT = 8;
const ROWS_PER_FORK = 12;
const CONCURRENT_SESSIONS = 4;
const CONCURRENT_CHUNKS = 20_000;
const GETS_PER_MANIFEST = 2;
const LARGEST_RESTORABLE = 500_000;
const OVER_CAP_PADDING = 120 * 1024 * 1024;

type Placement = { digest: string; packDigest: string; offset: number; length: number };
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

const SnapshotRequestSchema = z.object({
  snapshotId: z.string(),
  sessionId: z.string(),
  boxId: z.string(),
  turnId: z.string(),
  storageKey: z.string(),
});
const PackUploadsSchema = z.object({
  reply: z.object({ type: z.literal("SnapshotPackUploads"), uploads: z.array(z.object({ packDigest: z.string() })) }),
});
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
const PreparedOfferSchema = z.object({
  prepared: z.object({ kind: z.literal("Ready"), snapshots: z.array(z.object({ storageKey: z.string() })) }),
});

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const tree = (count: number, name = "tree"): Placement[] =>
  Array.from({ length: count }, (_, at) => ({
    digest: sha256(`${name} chunk ${at}`),
    packDigest: sha256(`${name} pack ${Math.floor(at / DIGESTS_PER_PART)}`),
    offset: (at % DIGESTS_PER_PART) * CHUNK_BYTES,
    length: CHUNK_BYTES,
  }));

const parts = (chunks: Placement[]): Placement[][] =>
  Array.from({ length: Math.ceil(chunks.length / DIGESTS_PER_PART) }, (_, at) =>
    chunks.slice(at * DIGESTS_PER_PART, (at + 1) * DIGESTS_PER_PART),
  );

const snapshotAsked = (host: Host, sessionId: string): z.infer<typeof SnapshotRequestSchema> => {
  const request = SnapshotRequestSchema.parse(host.take("SnapshotRequest"));
  assert.equal(request.sessionId, sessionId);
  return request;
};

const uploadsChunks = async (world: World, host: Host, snapshotId: string, chunks: Placement[]): Promise<void> => {
  for (const [at, part] of parts(chunks).entries()) {
    const packDigest = part[0]?.packDigest ?? "";
    await host.says({ type: "SnapshotChunks", snapshotId, part: at + 1, digests: part.map((chunk) => chunk.digest) });
    const answer = PackUploadsSchema.parse(
      await host.says({
        type: "SnapshotPacks",
        snapshotId,
        part: at + 1,
        packs: [{ packDigest, sizeBytes: part.length * CHUNK_BYTES }],
        chunks: part,
      }),
    );
    for (const upload of answer.reply.uploads) {
      await world.store.put(`${TENANT_ID}/packs/${upload.packDigest}`, "pack");
    }
  }
};

const storesRoot = (
  world: World,
  storageKey: string,
  chunks: Placement[],
  unknownEntries: object[] = [],
): Promise<string> => putsRoot(world.store, storageKey, chunks, unknownEntries, 0);

const putsRoot = async (
  store: R2Bucket,
  storageKey: string,
  chunks: Placement[],
  unknownEntries: object[],
  padding: number,
): Promise<string> => {
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
  await store.put(
    storageKey,
    JSON.stringify({ manifest: [{ digest, packDigest: digest, offset: 0, length: manifest.byteLength }] }),
  );
  return digest;
};

const insertsSnapshot = (
  world: World,
  snapshotId: string,
  request: z.infer<typeof SnapshotRequestSchema>,
  storageKey: string,
): void => {
  world
    .tenantSql()
    .exec(
      "INSERT INTO snapshots (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)",
      snapshotId,
      request.sessionId,
      request.boxId,
      request.turnId,
      storageKey,
      Date.now(),
      Date.now(),
    );
};

const failsSnapshot = async (host: Host, snapshotId: string): Promise<void> => {
  await host.says({
    type: "SnapshotFailed",
    snapshotId,
    reason: "UploadRejected",
    detail: "object storage refused the upload",
    failedAt: new Date(Date.now()).toISOString(),
  });
};

const storesSnapshot = async (world: World, host: Host, sessionId: string, chunks: Placement[]): Promise<string> => {
  const request = snapshotAsked(host, sessionId);
  await uploadsChunks(world, host, request.snapshotId, chunks);
  await storesRoot(world, request.storageKey, chunks);
  await host.says({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: chunks.length * CHUNK_BYTES });
  return request.storageKey;
};

const inWorld = async <T>(run: (world: World, host: Host) => Promise<T>): Promise<T> => {
  const world = await World.open();
  try {
    return await run(world, await world.hostOnline("host-1"));
  } finally {
    world.close();
  }
};

const rowsOfFailedSnapshot = (chunks: Placement[], attempts: number): Promise<number> =>
  inWorld(async (world, host) => {
    const session = await world.startSession({ prompt: "build the tree", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    const request = snapshotAsked(host, session.sessionId);
    const before = world.tenantRowsWritten();
    for (let attempt = 0; attempt < attempts; attempt++) {
      await uploadsChunks(world, host, request.snapshotId, chunks);
    }
    await failsSnapshot(host, request.snapshotId);
    const written = world.tenantRowsWritten() - before;
    for (const packDigest of new Set(chunks.map((chunk) => chunk.packDigest))) {
      assert.equal(await world.store.get(`${TENANT_ID}/packs/${packDigest}`), null, "no snapshot names the pack");
    }
    return written;
  });

const rowsOfStoredSnapshot = (chunks: Placement[]): Promise<number> =>
  inWorld(async (world, host) => {
    const session = await world.startSession({ prompt: "build the tree", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    const before = world.tenantRowsWritten();
    const root = await storesSnapshot(world, host, session.sessionId, chunks);
    const written = world.tenantRowsWritten() - before;

    await world.call("archiveSession", { tenantId: TENANT_ID, sessionId: session.sessionId, now: Date.now() });
    assert.equal(await world.store.get(root), null, "the archive frees the root");
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
    const offer = host.takeOffer();
    const answer = await world.call("prepareOffer", {
      tenantId: TENANT_ID,
      turnId: offer.turnId,
      hostId: host.hostId,
      now: Date.now(),
    });
    const parsed = PreparedOfferSchema.safeParse(answer);
    if (!parsed.success) throw new Error(`the fork was not offered: ${JSON.stringify(await world.turn(offer.turnId))}`);
    const { prepared } = parsed.data;
    assert.deepEqual(
      prepared.snapshots.map((snapshot) => snapshot.storageKey),
      [layer],
    );
    for (const [at, part] of parts(chunks).entries()) {
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

test("a snapshot of 100000 chunks that the host uploads 50 times and then fails writes the rows of a one-chunk snapshot that fails at once, and frees the packs it uploaded", async () => {
  const large = await rowsOfFailedSnapshot(tree(LARGE), 50);
  const small = await rowsOfFailedSnapshot(tree(1), 1);
  assert.equal(large, small);
  assert.ok(small <= ROWS_PER_FAILED_SNAPSHOT, `a failed snapshot wrote ${small} rows`);
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
    await uploadsChunks(world, host, request.snapshotId, chunks);

    const storedBefore = `${TENANT_ID}/${session.sessionId}/snapshots/stored-before`;
    const manifestPack = await storesRoot(world, storedBefore, chunks, [unknownEntry]);
    world
      .tenantSql()
      .exec(
        "INSERT INTO snapshots (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)",
        "stored-before",
        session.sessionId,
        request.boxId,
        request.turnId,
        storedBefore,
        chunks.length * CHUNK_BYTES,
        Date.now(),
        Date.now(),
      );

    await storesRoot(world, request.storageKey, chunks, [unknownEntry]);
    await host.says({
      type: "SnapshotDone",
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
    assert.equal(
      world.tenantSql().exec("SELECT failures FROM pack_collection").toArray()[0]?.failures,
      1,
      "retention stops on the unreadable snapshot",
    );
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

test("an object storage failure while SnapshotDone checks the packs fails only that snapshot, and the next one is stored", async () => {
  await inWorld(async (world, host) => {
    const chunks = tree(DIGESTS_PER_PART, "flaky storage");
    const session = await world.startSession({ prompt: "build while storage fails", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    const request = snapshotAsked(host, session.sessionId);
    await uploadsChunks(world, host, request.snapshotId, chunks);
    await storesRoot(world, request.storageKey, chunks);
    world.store.headFailure = new Error("object storage timed out");
    await host.says({
      type: "SnapshotDone",
      snapshotId: request.snapshotId,
      uploadedBytes: chunks.length * CHUNK_BYTES,
    });
    world.store.headFailure = null;

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

test("a manifest of 500000 chunks loads into an index within the memory the control plane holds", async () => {
  const world = await World.open();
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
    world.close();
  }
});

test("a stored snapshot whose index would pass the cap keeps its packs without stopping retention", async () => {
  await inWorld(async (world, host) => {
    const old = tree(DIGESTS_PER_PART, "over the cap");
    const first = await world.startSession({ prompt: "an old snapshot", tags: [] });
    const firstOffer = host.takeOffer();
    await host.claims(firstOffer);
    await host.completes(firstOffer);
    const firstRequest = snapshotAsked(host, first.sessionId);
    const firstChunks = tree(1, "first");
    await uploadsChunks(world, host, firstRequest.snapshotId, firstChunks);
    await storesRoot(world, firstRequest.storageKey, firstChunks);
    await host.says({ type: "SnapshotDone", snapshotId: firstRequest.snapshotId, uploadedBytes: CHUNK_BYTES });
    const storageKey = `${TENANT_ID}/${first.sessionId}/snapshots/over-the-cap`;
    const manifestPack = await putsRoot(world.store, storageKey, old, [], OVER_CAP_PADDING);
    for (const packDigest of new Set(old.map((chunk) => chunk.packDigest))) {
      await world.store.put(`${TENANT_ID}/packs/${packDigest}`, "pack");
    }
    insertsSnapshot(world, "over-the-cap", firstRequest, storageKey);
    const junk = `${TENANT_ID}/packs/${sha256("junk")}`;
    await world.store.put(junk, "junk");
    await world.passes(2 * 60_000);

    const second = await world.startSession({ prompt: "a new snapshot", tags: [] });
    const secondOffer = host.takeOffer();
    await host.claims(secondOffer);
    await host.completes(secondOffer);
    await storesSnapshot(world, host, second.sessionId, tree(1, "new"));

    assert.equal(world.tenantSql().exec("SELECT failures FROM pack_collection").toArray()[0]?.failures, 0);
    assert.equal(await world.store.get(junk), null, "retention frees the pack no snapshot names");
    for (const packDigest of new Set([manifestPack, ...old.map((chunk) => chunk.packDigest)])) {
      assert.notEqual(await world.store.get(`${TENANT_ID}/packs/${packDigest}`), null, `pack ${packDigest} is kept`);
    }
  });
});
