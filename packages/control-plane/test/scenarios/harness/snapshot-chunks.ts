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
