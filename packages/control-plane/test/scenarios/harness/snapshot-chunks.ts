import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { z } from "zod";
import { type Host, UNMETERED, World } from "./world.ts";

export const TENANT_ID = "tenant-scenario";
export const DIGESTS_PER_PART = 500;
export const CHUNK_BYTES = 65_536;

export type Placement = { digest: string; packDigest: string; offset: number; length: number };
export const SnapshotRequestSchema = z.object({
  snapshotId: z.string(),
  sessionId: z.string(),
  boxId: z.string(),
  turnId: z.string(),
  storageKey: z.string(),
});
export const PackUploadsSchema = z.object({
  reply: z.object({ type: z.literal("SnapshotPackUploads"), uploads: z.array(z.object({ packDigest: z.string() })) }),
});
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export const tree = (count: number, name = "tree"): Placement[] =>
  Array.from({ length: count }, (_, at) => ({
    digest: sha256(`${name} chunk ${at}`),
    packDigest: sha256(`${name} pack ${Math.floor(at / DIGESTS_PER_PART)}`),
    offset: (at % DIGESTS_PER_PART) * CHUNK_BYTES,
    length: CHUNK_BYTES,
  }));

export const parts = (chunks: Placement[]): Placement[][] =>
  Array.from({ length: Math.ceil(chunks.length / DIGESTS_PER_PART) }, (_, at) =>
    chunks.slice(at * DIGESTS_PER_PART, (at + 1) * DIGESTS_PER_PART),
  );

export const snapshotAsked = (host: Host, sessionId: string): z.infer<typeof SnapshotRequestSchema> => {
  for (;;) {
    const request = SnapshotRequestSchema.parse(host.take("SnapshotRequest"));
    if (request.sessionId === sessionId) return request;
  }
};

export const uploadsChunks = async (
  world: World,
  host: Host,
  snapshotId: string,
  chunks: Placement[],
): Promise<void> => {
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
        reusedPackDigests: [],
      }),
    );
    for (const upload of answer.reply.uploads) {
      await world.store.put(`${TENANT_ID}/packs/${upload.packDigest}`, "pack");
    }
  }
};

export const failsSnapshot = async (host: Host, snapshotId: string): Promise<void> => {
  await host.says({
    type: "SnapshotFailed",
    snapshotId,
    reason: "UploadRejected",
    detail: "object storage refused the upload",
    failedAt: new Date(Date.now()).toISOString(),
  });
};

export const inWorld = async <T>(run: (world: World, host: Host) => Promise<T>): Promise<T> => {
  const world = await World.open({ limits: UNMETERED });
  try {
    return await run(world, await world.hostOnline("host-1"));
  } finally {
    await world.close();
  }
};

export const storesTree = async (
  world: World,
  host: Host,
  sessionId: string,
  chunks: Placement[],
): Promise<Placement> => {
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

export const releasesBoxes = async (host: Host): Promise<void> => {
  while (host.received("BoxTeardown").length > 0) {
    const teardown = z.object({ sessionId: z.string(), boxId: z.string() }).parse(host.take("BoxTeardown"));
    await host.says({ type: "BoxGone", sessionId: teardown.sessionId, boxId: teardown.boxId });
  }
};
