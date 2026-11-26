import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import { z } from "zod";
import { turnCredentialSeconds } from "../../src/settings.ts";
import { type Host, TENANT_ID, UNMETERED, World } from "./harness/world.ts";

const BUDGET_MS = 30;

const CHUNK_BYTES = 65_536;
const DIGESTS_PER_PART = 500;

const RESTORED_CHUNKS = 200_000;
const _RESULT = '{"type":"result","subtype":"success","is_error":false}';

type Placement = { digest: string; packDigest: string; offset: number; length: number };

const RestoreReplySchema = z.object({
  reply: z.object({
    type: z.literal("RestoreDownloads"),
    packs: z.array(z.object({ packDigest: z.string(), url: z.string() })),
  }),
});

const partsOf = (chunks: Placement[]): Placement[][] =>
  Array.from({ length: Math.ceil(chunks.length / DIGESTS_PER_PART) }, (_, at) =>
    chunks.slice(at * DIGESTS_PER_PART, (at + 1) * DIGESTS_PER_PART),
  );

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const tree = (count: number): Placement[] =>
  Array.from({ length: count }, (_, at) => ({
    digest: sha256(`tree chunk ${at}`),
    packDigest: sha256(`tree pack ${Math.floor(at / DIGESTS_PER_PART)}`),
    offset: (at % DIGESTS_PER_PART) * CHUNK_BYTES,
    length: CHUNK_BYTES,
  }));

const storesTree = async (world: World, host: Host, sessionId: string, chunks: Placement[]): Promise<Placement> => {
  const request = z
    .object({ snapshotId: z.string(), sessionId: z.string(), storageKey: z.string() })
    .parse(host.take("SnapshotRequest"));
  assert.equal(request.sessionId, sessionId);
  for (let at = 0; at * DIGESTS_PER_PART < chunks.length; at++) {
    const part = chunks.slice(at * DIGESTS_PER_PART, (at + 1) * DIGESTS_PER_PART);
    const packDigest = part[0]?.packDigest ?? "";
    await host.says({
      type: "SnapshotChunks",
      snapshotId: request.snapshotId,
      part: at + 1,
      digests: part.map((chunk) => chunk.digest),
    });
    const answer = z.object({ reply: z.object({ uploads: z.array(z.object({ packDigest: z.string() })) }) }).parse(
      await host.says({
        type: "SnapshotPacks",
        snapshotId: request.snapshotId,
        part: at + 1,
        packs: [{ packDigest, sizeBytes: part.length * CHUNK_BYTES }],
        chunks: part,
        reusedPackDigests: [],
      }),
    );
    for (const upload of answer.reply.uploads) await world.store.put(`${TENANT_ID}/packs/${upload.packDigest}`, "pack");
  }
  const manifest = JSON.stringify({
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
  const digest = sha256(manifest);
  const root = { digest, packDigest: digest, offset: 0, length: manifest.length };
  await world.store.put(`${TENANT_ID}/packs/${digest}`, manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
  await host.says({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: Math.ceil(chunks.length / DIGESTS_PER_PART) + 1,
    packs: [{ packDigest: digest, sizeBytes: manifest.length }],
    chunks: [root],
    reusedPackDigests: [],
  });
  await host.says({
    type: "SnapshotDone",
    snapshotId: request.snapshotId,
    uploadedBytes: chunks.length * CHUNK_BYTES,
    chunkCount: chunks.length,
  });
  return root;
};

const releasesBoxes = async (host: Host): Promise<void> => {
  while (host.received("BoxTeardown").length > 0) {
    const teardown = z.object({ sessionId: z.string(), boxId: z.string() }).parse(host.take("BoxTeardown"));
    await host.says({ type: "BoxGone", sessionId: teardown.sessionId, boxId: teardown.boxId });
  }
};

test("a host of the tenant gets the restore URLs of a 200000-chunk snapshot with no offered turn or open window, each part within the budget on a restarted tenant", {
  timeout: 900_000,
}, async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const chunks = tree(RESTORED_CHUNKS);
  const session = await world.startSession({ prompt: "build the large tree", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const root = await storesTree(world, host, session.sessionId, chunks);
  await releasesBoxes(host);
  const lost = chunks.at(-1)?.packDigest ?? "";
  await world.store.delete(`${TENANT_ID}/packs/${lost}`);
  await world.tick(turnCredentialSeconds(world.settings) * 1000);
  await world.restartTenant();

  const asked = [[root], ...partsOf(chunks)];
  const spent: number[] = [];
  for (const [at, part] of asked.entries()) {
    const input = {
      tenantId: TENANT_ID,
      hostId: host.hostId,
      message: { type: "RestoreChunks", turnId: offer.turnId, part: at + 1, chunks: part },
    };
    spent.push(await world.coldMs("hostMessage", input));
    const { reply } = RestoreReplySchema.parse(await world.call("hostMessage", input));
    const packs = [...new Set(part.map((chunk) => chunk.packDigest))].filter((packDigest) => packDigest !== lost);
    assert.deepEqual(
      reply.packs.map((pack) => pack.packDigest),
      packs,
      `part ${at + 1}`,
    );
    for (const pack of reply.packs) assert.match(pack.url, new RegExp(`/packs/${pack.packDigest}`));
  }
  console.log(`first part ${spent[0]?.toFixed(2)} ms, slowest ${Math.max(...spent).toFixed(2)} ms`);
  const over = spent.flatMap((ms, at) => (ms > BUDGET_MS ? [`part ${at + 1}: ${ms.toFixed(2)} ms`] : []));
  assert.deepEqual(over, [], `RestoreChunks parts over ${BUDGET_MS} ms of compute`);
});

test("a chunk ask after a restart stays inside the budget, whatever the size of the previous snapshot", {
  timeout: 900_000,
}, async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.holdsAgentCredentials();
  const session = await world.startSession({ prompt: "build a large tree", tags: [] });
  const chunks = tree(200_000);
  const first = host.takeOffer();
  await host.claims(first);
  await host.completes(first);
  await storesTree(world, host, session.sessionId, chunks);
  await releasesBoxes(host);
  await world.sendTurn(session.sessionId, "change one file");
  const second = host.takeOffer();
  await host.claims(second);
  await host.completes(second);
  const request = z.object({ snapshotId: z.string() }).parse(host.received("SnapshotRequest").at(-1));

  const ms = await world.coldMs("hostMessage", {
    tenantId: TENANT_ID,
    hostId: host.hostId,
    message: {
      type: "SnapshotChunks",
      snapshotId: request.snapshotId,
      part: 1,
      digests: chunks.slice(0, DIGESTS_PER_PART).map((chunk) => chunk.digest),
    },
  });
  console.log(`${ms.toFixed(2)} ms for the first chunk ask after a restart`);
  assert.ok(ms <= BUDGET_MS, `the first chunk ask after a restart took ${ms.toFixed(2)} ms`);
});

const MIB = 1_048_576;
const CHUNKS_PER_PACK = 16;
const R2_LATENCY_MS = 25;
const MAX_INDEX_BYTES = 3_014_672;

const ChunkCheckReplySchema = z.object({
  reply: z.object({
    type: z.literal("SnapshotChunkCheckHeld"),
    snapshotId: z.string(),
    check: z.number(),
    held: z.array(z.unknown()),
  }),
});

const streamChunks = (count: number): Placement[] =>
  Array.from({ length: count }, (_, at) => ({
    digest: sha256(`stream chunk ${at}`),
    packDigest: sha256(`stream pack ${Math.floor(at / CHUNKS_PER_PACK)}`),
    offset: (at % CHUNKS_PER_PACK) * MIB,
    length: MIB,
  }));

const indexOf = (chunks: Placement[]): Uint8Array => {
  const packs = [...new Set(chunks.map((chunk) => chunk.packDigest))].sort();
  const records = chunks.toSorted((a, b) => (a.digest < b.digest ? -1 : 1));
  const bytes = new Uint8Array(16 + packs.length * 32 + records.length * 44);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("TPIX"), 0);
  view.setUint32(4, 1, true);
  view.setUint32(8, packs.length, true);
  view.setUint32(12, records.length, true);
  for (const [at, pack] of packs.entries()) bytes.set(Buffer.from(pack, "hex"), 16 + at * 32);
  for (const [at, record] of records.entries()) {
    const start = 16 + packs.length * 32 + at * 44;
    bytes.set(Buffer.from(record.digest, "hex"), start);
    view.setUint32(start + 32, packs.indexOf(record.packDigest), true);
    view.setUint32(start + 36, record.offset, true);
    view.setUint32(start + 40, record.length, true);
  }
  return bytes;
};

const storageKeyOf = (world: World, sessionId: string): string =>
  z
    .object({ storage_key: z.string() })
    .parse(
      world
        .tenantSql()
        .exec("SELECT storage_key FROM snapshots WHERE session_id = ? ORDER BY snapshot_seq DESC LIMIT 1", sessionId)
        .one(),
    ).storage_key;

for (const entries of [2_098, 32_768, 65_536]) {
  test(`a chunk check of 100 digests over a ${entries}-entry .idx gets its 60 held placements from one GET within the budget on a restarted tenant`, {
    timeout: 900_000,
  }, async (t) => {
    const world = await World.open({ limits: UNMETERED });
    t.after(() => world.close());
    const host = await world.online(world.owner, "host-1", { protocolVersion: ChannelProtocol.Version });
    await world.holdsAgentCredentials();
    const session = await world.startSession({ prompt: "build a stream snapshot", tags: [] });
    const first = host.takeOffer();
    await host.claims(first);
    await host.completes(first);
    await storesTree(world, host, session.sessionId, tree(10));
    await releasesBoxes(host);
    const chunks = streamChunks(entries);
    await world.store.put(`${storageKeyOf(world, session.sessionId)}.idx`, indexOf(chunks));
    await world.sendTurn(session.sessionId, "change one file");
    const second = host.takeOffer();
    await host.claims(second);
    await host.completes(second);
    const request = z.object({ snapshotId: z.string() }).parse(host.received("SnapshotRequest").at(-1));
    const held = Array.from({ length: 60 }, (_, at) => chunks[Math.floor((at * entries) / 60)] as Placement);
    const unheld = streamChunks(entries + 40).slice(entries);
    const asked = [...held.slice(0, 30), ...unheld, ...held.slice(30)];

    world.store.latencyMs = R2_LATENCY_MS;
    const input = {
      tenantId: TENANT_ID,
      hostId: host.hostId,
      message: {
        type: "SnapshotChunkCheck",
        snapshotId: request.snapshotId,
        check: 1,
        digests: asked.map((chunk) => chunk.digest),
      },
    };
    const gets = world.store.gets;
    const started = performance.now();
    const cpu = await world.coldMs("hostMessage", input);
    const wall = performance.now() - started;
    assert.equal(world.store.gets - gets, 1, "one GET of the whole .idx");
    console.log(`${entries} entries: ${cpu.toFixed(2)} ms CPU, ${wall.toFixed(2)} ms wall, cold`);
    assert.ok(cpu <= BUDGET_MS, `the first chunk check after a restart took ${cpu.toFixed(2)} ms`);
    const { reply } = ChunkCheckReplySchema.parse(await world.call("hostMessage", input));
    assert.deepEqual(reply, { type: "SnapshotChunkCheckHeld", snapshotId: request.snapshotId, check: 1, held });
  });
}

test("the chunk check answers from the previous snapshot's .idx over the channel, refuses 101 digests, holds nothing without an .idx, and a released snapshot's .idx is deleted", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", { protocolVersion: ChannelProtocol.Version });
  await world.holdsAgentCredentials();
  const session = await world.startSession({ prompt: "build a tree", tags: [] });
  const first = host.takeOffer();
  await host.claims(first);
  await host.completes(first);
  const chunks = tree(10);
  await storesTree(world, host, session.sessionId, chunks);
  await releasesBoxes(host);
  const previous = storageKeyOf(world, session.sessionId);
  await world.sendTurn(session.sessionId, "change one file");
  const second = host.takeOffer();
  await host.claims(second);
  await host.completes(second);
  const request = z
    .object({ snapshotId: z.string(), storageKey: z.string() })
    .parse(host.received("SnapshotRequest").at(-1));
  const digests = chunks.map((chunk) => chunk.digest);

  assert.deepEqual(
    (await host.says({ type: "SnapshotChunkCheck", snapshotId: request.snapshotId, check: 1, digests })).reply,
    { type: "SnapshotChunkCheckHeld", snapshotId: request.snapshotId, check: 1, held: [] },
  );
  await assert.rejects(
    host.says({
      type: "SnapshotChunkCheck",
      snapshotId: request.snapshotId,
      check: 2,
      digests: streamChunks(101).map((chunk) => chunk.digest),
    }),
    /the control plane refused SnapshotChunkCheck/,
  );
  await world.store.put(`${previous}.idx`, new Uint8Array(MAX_INDEX_BYTES + 1));
  await assert.rejects(
    host.says({ type: "SnapshotChunkCheck", snapshotId: request.snapshotId, check: 3, digests }),
    new RegExp(`holds ${MAX_INDEX_BYTES + 1} bytes, above the ${MAX_INDEX_BYTES} of the largest snapshot's index`),
  );
  await assert.rejects(
    host.says({
      type: "SnapshotIndexAsk",
      snapshotId: request.snapshotId,
      sizeBytes: MAX_INDEX_BYTES + 1,
      digest: "b".repeat(64),
    }),
    /the control plane refused SnapshotIndexAsk: .* above the \d+ of the largest snapshot's index/,
  );
  await world.store.put(`${previous}.idx`, indexOf(chunks.slice(0, 1)));
  assert.deepEqual(
    (await host.says({ type: "SnapshotChunkCheck", snapshotId: request.snapshotId, check: 3, digests })).reply,
    { type: "SnapshotChunkCheckHeld", snapshotId: request.snapshotId, check: 3, held: chunks.slice(0, 1) },
  );
  const upload = z.object({ reply: z.object({ type: z.literal("SnapshotIndexUpload"), url: z.string() }) }).parse(
    await host.says({
      type: "SnapshotIndexAsk",
      snapshotId: request.snapshotId,
      sizeBytes: 60,
      digest: "b".repeat(64),
    }),
  );
  assert.ok(upload.reply.url.includes(`/${request.storageKey}.idx?`), upload.reply.url);

  await storesTree(world, host, session.sessionId, tree(5));
  assert.equal(await world.store.head(`${previous}.idx`), null);
});
