import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import { World } from "./harness/world.ts";

const TENANT_ID = "tenant-scenario";
const MINUTE = 60_000;
const IDLE_EVICTION = 15 * MINUTE;
const CHUNK_BYTES = 65_536;

const SnapshotRequestSchema = z.object({ snapshotId: z.string(), sessionId: z.string(), storageKey: z.string() });
const PackUploadsSchema = z.object({
  reply: z.object({ type: z.literal("SnapshotPackUploads"), uploads: z.array(z.object({ packDigest: z.string() })) }),
});
const RestoreDownloadsSchema = z.object({
  reply: z.object({ type: z.literal("RestoreDownloads"), packs: z.array(z.object({ packDigest: z.string() })) }),
});
const PreparedOfferSchema = z.object({
  prepared: z.object({ kind: z.literal("Ready"), snapshots: z.array(z.object({ storageKey: z.string() })) }),
});

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

test("a snapshot taken after the move to object storage restores on a fresh box after an idle stop, its manifest chunks first", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.holdsAgentCredentials();

  const session = await world.startSession({ prompt: "build the tree", tags: [] });
  const first = host.takeOffer();
  await host.claims(first);
  await host.completes(first);
  const request = SnapshotRequestSchema.parse(host.take("SnapshotRequest"));
  assert.equal(request.sessionId, session.sessionId);

  const filePack = sha256("file pack");
  const fileChunks = [0, 1].map((at) => ({
    digest: sha256(`file chunk ${at}`),
    packDigest: filePack,
    offset: at * CHUNK_BYTES,
    length: CHUNK_BYTES,
  }));
  await host.says({
    type: "SnapshotChunks",
    snapshotId: request.snapshotId,
    part: 1,
    digests: fileChunks.map((chunk) => chunk.digest),
  });
  const uploads = PackUploadsSchema.parse(
    await host.says({
      type: "SnapshotPacks",
      snapshotId: request.snapshotId,
      part: 1,
      packs: [{ packDigest: filePack, sizeBytes: 2 * CHUNK_BYTES }],
      chunks: fileChunks,
    }),
  );
  assert.deepEqual(
    uploads.reply.uploads.map((upload) => upload.packDigest),
    [filePack],
  );
  await world.store.put(`${TENANT_ID}/packs/${filePack}`, "pack");
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
        sizeBytes: 2 * CHUNK_BYTES,
        chunks: fileChunks,
      },
    ],
  });
  const half = Math.floor(manifest.length / 2);
  const manifestPack = sha256(manifest);
  const manifestChunks = [
    { digest: sha256(manifest.slice(0, half)), packDigest: manifestPack, offset: 0, length: half },
    {
      digest: sha256(manifest.slice(half)),
      packDigest: manifestPack,
      offset: half,
      length: manifest.length - half,
    },
  ];
  await world.store.put(`${TENANT_ID}/packs/${manifestPack}`, manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: manifestChunks }));
  await host.says({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: manifest.length });

  await world.passes(IDLE_EVICTION);
  await host.tearsDownBox(session.sessionId);
  assert.equal((await world.session(session.sessionId)).state, "Stopped");

  await world.sendTurn(session.sessionId, "change the tree");
  const resumed = host.takeOffer();
  assert.notEqual(resumed.boxId, first.boxId, "the resume runs on a fresh box");
  const { prepared } = PreparedOfferSchema.parse(
    await world.call("prepareOffer", {
      tenantId: TENANT_ID,
      turnId: resumed.turnId,
      hostId: host.hostId,
      now: Date.now(),
    }),
  );
  assert.deepEqual(
    prepared.snapshots.map((snapshot) => snapshot.storageKey),
    [request.storageKey],
  );

  const manifestDownloads = RestoreDownloadsSchema.parse(
    await host.says({ type: "RestoreChunks", turnId: resumed.turnId, part: 1, chunks: manifestChunks }),
  );
  assert.deepEqual(
    manifestDownloads.reply.packs.map((pack) => pack.packDigest),
    [manifestPack],
  );
  const fileDownloads = RestoreDownloadsSchema.parse(
    await host.says({ type: "RestoreChunks", turnId: resumed.turnId, part: 2, chunks: fileChunks }),
  );
  assert.deepEqual(
    fileDownloads.reply.packs.map((pack) => pack.packDigest),
    [filePack],
  );
});
