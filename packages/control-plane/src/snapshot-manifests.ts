import { ChunkPlacementSchema, SnapshotManifestSchema, SnapshotRootSchema } from "@tumpel/schemas";
import { z } from "zod";

export type Placement = z.infer<typeof ChunkPlacementSchema>;

export type ManifestRead<T> =
  | { kind: "Read"; value: T }
  | { kind: "Gone"; detail: string }
  | { kind: "Unreadable"; detail: string };

const PackListSchema = z.array(z.string());
const DIGEST_CHARS = 64;
const CACHED_INDEX_BYTES = 16 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 24 * 1024 * 1024;
const CACHED_PACK_LISTS = 1000;

export const packKey = (tenantId: string, packDigest: string): string => `${tenantId}/packs/${packDigest}`;

export const packListKey = (storageKey: string): string => `${storageKey}.packs`;

export const manifestBytes = (root: Placement[]): number =>
  root.reduce((total, placement) => total + placement.length, 0);

const issues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

const parsedJson = (text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown => {
  try {
    return JSON.parse(text, reviver);
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const parsedManifest = (storageKey: string, text: string): ManifestRead<Placement[]> => {
  const chunks: Placement[] = [];
  const packDigests = new Map<string, string>();
  let invalid: string | undefined;
  const tree = parsedJson(text, function (this: unknown, _key: string, value: unknown): unknown {
    if (!Array.isArray(this) || !isRecord(value) || !("packDigest" in value)) return value;
    const placement = ChunkPlacementSchema.safeParse(value);
    if (!placement.success) {
      invalid ??= issues(placement.error);
      return value;
    }
    const packDigest = packDigests.get(placement.data.packDigest) ?? placement.data.packDigest;
    packDigests.set(packDigest, packDigest);
    chunks.push({ ...placement.data, packDigest });
    return undefined;
  });
  if (invalid !== undefined) {
    return { kind: "Unreadable", detail: `the manifest of ${storageKey} places a chunk wrongly: ${invalid}` };
  }
  const entries = isRecord(tree) && Array.isArray(tree.entries) ? tree.entries : [];
  for (const entry of entries) {
    if (isRecord(entry) && entry.kind === "File" && Array.isArray(entry.chunks)) entry.chunks = [];
  }
  const parsed = SnapshotManifestSchema.safeParse(tree);
  if (!parsed.success) {
    return { kind: "Unreadable", detail: `the manifest of ${storageKey} is no manifest: ${issues(parsed.error)}` };
  }
  return { kind: "Read", value: chunks };
};

const remember = <T>(cache: Map<string, T>, key: string, value: T, limit: number): T => {
  cache.set(key, value);
  for (const oldest of cache.keys()) {
    if (cache.size <= limit) break;
    cache.delete(oldest);
  }
  return value;
};

const ranges = (manifest: Placement[]): { packDigest: string; offset: number; length: number }[] => {
  const merged: { packDigest: string; offset: number; length: number }[] = [];
  for (const placement of manifest) {
    const last = merged.at(-1);
    if (last?.packDigest === placement.packDigest && last.offset + last.length === placement.offset) {
      last.length += placement.length;
      continue;
    }
    merged.push({ packDigest: placement.packDigest, offset: placement.offset, length: placement.length });
  }
  return merged;
};

export class SnapshotIndex {
  private readonly digests: string;
  private readonly packs: string[];
  private readonly packOf: Uint32Array;
  private readonly offsets: Float64Array;
  private readonly lengths: Float64Array;

  private constructor(
    digests: string,
    packs: string[],
    packOf: Uint32Array,
    offsets: Float64Array,
    lengths: Float64Array,
  ) {
    this.digests = digests;
    this.packs = packs;
    this.packOf = packOf;
    this.offsets = offsets;
    this.lengths = lengths;
  }

  static of(chunks: Placement[]): SnapshotIndex {
    const order = chunks
      .map((chunk, at) => ({ digest: chunk.digest, at }))
      .sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : left.at - right.at));
    const packAt = new Map<string, number>();
    const packOf = new Uint32Array(order.length);
    const offsets = new Float64Array(order.length);
    const lengths = new Float64Array(order.length);
    for (const [slot, { at }] of order.entries()) {
      const chunk = chunks[at] as Placement;
      const pack = packAt.get(chunk.packDigest) ?? packAt.size;
      packAt.set(chunk.packDigest, pack);
      packOf[slot] = pack;
      offsets[slot] = chunk.offset;
      lengths[slot] = chunk.length;
    }
    return new SnapshotIndex(order.map((entry) => entry.digest).join(""), [...packAt.keys()], packOf, offsets, lengths);
  }

  get bytes(): number {
    return (
      this.digests.length +
      this.packs.length * DIGEST_CHARS +
      this.packOf.byteLength +
      this.offsets.byteLength +
      this.lengths.byteLength
    );
  }

  find(digest: string): Placement | undefined {
    const slot = this.first(digest);
    return slot === undefined ? undefined : this.placement(slot);
  }

  holds(placement: Placement): boolean {
    const first = this.first(placement.digest);
    if (first === undefined) return false;
    for (let slot = first; slot < this.packOf.length && this.digestAt(slot) === placement.digest; slot++) {
      if (
        this.packs[this.packOf[slot] as number] === placement.packDigest &&
        this.offsets[slot] === placement.offset &&
        this.lengths[slot] === placement.length
      ) {
        return true;
      }
    }
    return false;
  }

  private digestAt(slot: number): string {
    return this.digests.slice(slot * DIGEST_CHARS, (slot + 1) * DIGEST_CHARS);
  }

  private placement(slot: number): Placement {
    return {
      digest: this.digestAt(slot),
      packDigest: this.packs[this.packOf[slot] as number] as string,
      offset: this.offsets[slot] as number,
      length: this.lengths[slot] as number,
    };
  }

  private first(digest: string): number | undefined {
    let low = 0;
    let high = this.packOf.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.digestAt(middle) < digest) low = middle + 1;
      else high = middle;
    }
    return low < this.packOf.length && this.digestAt(low) === digest ? low : undefined;
  }
}

export class SnapshotManifests {
  private readonly indexes = new Map<string, SnapshotIndex>();
  private readonly loading = new Map<string, Promise<ManifestRead<SnapshotIndex>>>();
  private readonly packLists = new Map<string, ReadonlySet<string>>();
  private parsing: Promise<unknown> = Promise.resolve();

  async index(store: R2Bucket, tenantId: string, storageKey: string): Promise<ManifestRead<SnapshotIndex>> {
    const held = this.indexes.get(storageKey);
    if (held !== undefined) {
      this.indexes.delete(storageKey);
      this.indexes.set(storageKey, held);
      return { kind: "Read", value: held };
    }
    const loading = this.loading.get(storageKey);
    if (loading !== undefined) return loading;
    const load = this.oneAtATime(() => this.load(store, tenantId, storageKey)).finally(() =>
      this.loading.delete(storageKey),
    );
    this.loading.set(storageKey, load);
    return load;
  }

  async packs(store: R2Bucket, tenantId: string, storageKey: string): Promise<ManifestRead<ReadonlySet<string>>> {
    const held = this.packLists.get(storageKey);
    if (held !== undefined) return { kind: "Read", value: held };
    const listed = await store.get(packListKey(storageKey));
    if (listed !== null) {
      const parsed = PackListSchema.safeParse(parsedJson(await listed.text()));
      if (!parsed.success) {
        return { kind: "Unreadable", detail: `the pack list of ${storageKey} is no list: ${issues(parsed.error)}` };
      }
      return { kind: "Read", value: remember(this.packLists, storageKey, new Set(parsed.data), CACHED_PACK_LISTS) };
    }
    const read = await this.oneAtATime(async (): Promise<ManifestRead<ReadonlySet<string>>> => {
      const manifest = await this.manifest(store, tenantId, storageKey);
      if (manifest.kind !== "Read") return manifest;
      return {
        kind: "Read",
        value: new Set([
          ...manifest.value.root.map((placement) => placement.packDigest),
          ...manifest.value.chunks.map((placement) => placement.packDigest),
        ]),
      };
    });
    if (read.kind !== "Read") return read;
    await store.put(packListKey(storageKey), JSON.stringify([...read.value].sort()));
    return { kind: "Read", value: remember(this.packLists, storageKey, read.value, CACHED_PACK_LISTS) };
  }

  forget(storageKey: string): void {
    this.indexes.delete(storageKey);
    this.packLists.delete(storageKey);
  }

  private oneAtATime<T>(run: () => Promise<T>): Promise<T> {
    const turn = this.parsing.then(run);
    this.parsing = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  private async load(store: R2Bucket, tenantId: string, storageKey: string): Promise<ManifestRead<SnapshotIndex>> {
    const read = await this.manifest(store, tenantId, storageKey);
    if (read.kind !== "Read") return read;
    const index = SnapshotIndex.of(read.value.chunks);
    this.indexes.set(storageKey, index);
    let bytes = [...this.indexes.values()].reduce((total, cached) => total + cached.bytes, 0);
    for (const [key, cached] of this.indexes) {
      if (bytes <= CACHED_INDEX_BYTES || key === storageKey) break;
      this.indexes.delete(key);
      bytes -= cached.bytes;
    }
    return { kind: "Read", value: index };
  }

  private async manifest(
    store: R2Bucket,
    tenantId: string,
    storageKey: string,
  ): Promise<ManifestRead<{ root: Placement[]; chunks: Placement[] }>> {
    const root = await store.get(storageKey);
    if (root === null) return { kind: "Gone", detail: `object storage holds no snapshot root under ${storageKey}` };
    const parsedRoot = SnapshotRootSchema.safeParse(parsedJson(await root.text()));
    if (!parsedRoot.success) {
      return { kind: "Unreadable", detail: `${storageKey} is no snapshot root: ${issues(parsedRoot.error)}` };
    }
    const size = manifestBytes(parsedRoot.data.manifest);
    if (size > MAX_MANIFEST_BYTES) {
      return {
        kind: "Unreadable",
        detail: `the manifest of ${storageKey} is ${size} bytes, above the ${MAX_MANIFEST_BYTES} bytes the control plane reads`,
      };
    }
    const decoder = new TextDecoder();
    let text = "";
    for (const range of ranges(parsedRoot.data.manifest)) {
      const body = await store.get(packKey(tenantId, range.packDigest), {
        range: { offset: range.offset, length: range.length },
      });
      if (body === null) {
        return {
          kind: "Unreadable",
          detail: `the manifest of ${storageKey} lies in pack ${range.packDigest}, which object storage does not hold`,
        };
      }
      text += decoder.decode(new Uint8Array(await body.arrayBuffer()), { stream: true });
    }
    text += decoder.decode();
    const chunks = parsedManifest(storageKey, text);
    if (chunks.kind !== "Read") return chunks;
    return { kind: "Read", value: { root: parsedRoot.data.manifest, chunks: chunks.value } };
  }
}
