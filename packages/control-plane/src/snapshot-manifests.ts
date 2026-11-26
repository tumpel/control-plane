import type { ChunkPlacementSchema } from "@tumpel/schemas";
import { z } from "zod";

export type Placement = z.infer<typeof ChunkPlacementSchema>;

export type ManifestRead<T> = { kind: "Read"; value: T } | { kind: "Unreadable"; detail: string };

export const PackListSchema = z.array(z.string());
export const MAX_PACKS_PER_MANIFEST = 16_384;
export const STORE_DELETE_BATCH = 1000;

export const packKey = (tenantId: string, packDigest: string): string => `${tenantId}/packs/${packDigest}`;

export const packListKey = (storageKey: string): string => `${storageKey}.packs`;

export const draftKey = (storageKey: string): string => `${storageKey}.draft`;

export const indexKey = (storageKey: string): string => `${storageKey}.idx`;

const INDEX_HEADER_BYTES = 16;
const INDEX_PACK_BYTES = 32;
const INDEX_RECORD_BYTES = 44;
const LARGEST_SNAPSHOT_BYTES = 32 * 1024 ** 3;
const SMALLEST_CHUNK_BYTES = 512 * 1024;
const SMALLEST_CLOSED_PACK_BYTES = 8 * 1024 ** 2;
export const MAX_INDEX_BYTES =
  INDEX_HEADER_BYTES +
  (LARGEST_SNAPSHOT_BYTES / SMALLEST_CLOSED_PACK_BYTES) * INDEX_PACK_BYTES +
  (LARGEST_SNAPSHOT_BYTES / SMALLEST_CHUNK_BYTES) * INDEX_RECORD_BYTES;

const hexOf = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

const bytesOf = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, at) => Number.parseInt(hex.slice(at * 2, at * 2 + 2), 16));

const compared = (bytes: Uint8Array, at: number, digest: Uint8Array): number => {
  for (let byte = 0; byte < digest.length; byte++) {
    const difference = (bytes[at + byte] ?? 0) - (digest[byte] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export const heldPlacements = async (
  store: R2Bucket,
  storageKey: string,
  digests: string[],
): Promise<ManifestRead<Placement[]>> => {
  const object = await store.get(indexKey(storageKey));
  if (object === null) return { kind: "Read", value: [] };
  if (object.size > MAX_INDEX_BYTES) {
    return {
      kind: "Unreadable",
      detail: `${indexKey(storageKey)} holds ${object.size} bytes, above the ${MAX_INDEX_BYTES} of the largest snapshot's index`,
    };
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (bytes.byteLength < INDEX_HEADER_BYTES || magic !== "TPIX" || view.getUint32(4, true) !== 1) {
    return { kind: "Unreadable", detail: `${indexKey(storageKey)} is no version 1 chunk index` };
  }
  const packs = view.getUint32(8, true);
  const records = view.getUint32(12, true);
  const recordsAt = INDEX_HEADER_BYTES + packs * INDEX_PACK_BYTES;
  const size = recordsAt + records * INDEX_RECORD_BYTES;
  if (bytes.byteLength !== size) {
    return {
      kind: "Unreadable",
      detail: `${indexKey(storageKey)} holds ${bytes.byteLength} bytes, but its ${packs} packs and ${records} records take ${size}`,
    };
  }
  const held: Placement[] = [];
  for (const digest of digests) {
    const wanted = bytesOf(digest);
    let low = 0;
    let high = records;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compared(bytes, recordsAt + middle * INDEX_RECORD_BYTES, wanted) < 0) low = middle + 1;
      else high = middle;
    }
    const at = recordsAt + low * INDEX_RECORD_BYTES;
    if (low === records || compared(bytes, at, wanted) !== 0) continue;
    const pack = view.getUint32(at + 32, true);
    if (pack >= packs) {
      return {
        kind: "Unreadable",
        detail: `${indexKey(storageKey)} places chunk ${digest} in pack ${pack}, but it lists ${packs} packs`,
      };
    }
    const packAt = INDEX_HEADER_BYTES + pack * INDEX_PACK_BYTES;
    held.push({
      digest,
      packDigest: hexOf(bytes.subarray(packAt, packAt + INDEX_PACK_BYTES)),
      offset: view.getUint32(at + 36, true),
      length: view.getUint32(at + 40, true),
    });
  }
  return { kind: "Read", value: held };
};

const issues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

export const packList = async (
  store: R2Bucket,
  storageKey: string,
): Promise<{ kind: "Read"; value: ReadonlySet<string> } | { kind: "Unreadable"; detail: string } | null> => {
  const listed = await store.get(packListKey(storageKey));
  if (listed === null) return null;
  const parsed = PackListSchema.safeParse(parsedJson(await listed.text()));
  if (!parsed.success) {
    return { kind: "Unreadable", detail: `the pack list of ${storageKey} is no list: ${issues(parsed.error)}` };
  }
  return { kind: "Read", value: new Set(parsed.data) };
};

const SnapshotDraftSchema = z.object({
  lastPart: z.number().int().min(1),
  packs: z.array(z.string()),
  reused: z.array(z.string()).default([]),
});

type SnapshotDraft = z.infer<typeof SnapshotDraftSchema>;

export const mergedDraft = (
  draft: SnapshotDraft | null,
  part: number,
  written: string[],
  reused: string[],
): { kind: "Merged"; draft: SnapshotDraft } | { kind: "Refused"; detail: string } => {
  const continues = draft !== null && (part === draft.lastPart || part === draft.lastPart + 1);
  if (part !== 1 && !continues) {
    return {
      kind: "Refused",
      detail: `but the control plane expects part ${draft === null ? 1 : draft.lastPart + 1}, so the snapshot cannot name its packs`,
    };
  }
  const earlier = part === 1 || draft === null ? { packs: [], reused: [] } : draft;
  const merged = new Set([...earlier.packs, ...written, ...reused]);
  if (merged.size > MAX_PACKS_PER_MANIFEST) {
    return {
      kind: "Refused",
      detail: `which brings it to ${merged.size} packs, above the ${MAX_PACKS_PER_MANIFEST} the control plane indexes, so the snapshot cannot name its packs`,
    };
  }
  return {
    kind: "Merged",
    draft: { lastPart: part, packs: [...merged], reused: [...new Set([...earlier.reused, ...reused])] },
  };
};

export const snapshotDraft = async (store: R2Bucket, storageKey: string): Promise<SnapshotDraft | null> => {
  const draft = await store.get(draftKey(storageKey));
  if (draft === null) return null;
  const parsed = SnapshotDraftSchema.safeParse(parsedJson(await draft.text()));
  if (!parsed.success) throw new Error(`the pack draft of ${storageKey} does not parse: ${issues(parsed.error)}`);
  return parsed.data;
};

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
