import JSONParser from "@streamparser/json/jsonparser.js";
import { ChunkPlacementSchema, SnapshotManifestSchema, SnapshotRootSchema } from "@tumpel/schemas";
import { z } from "zod";

export type Placement = z.infer<typeof ChunkPlacementSchema>;

export type ManifestRead<T> =
  | { kind: "Read"; value: T }
  | { kind: "Gone"; detail: string }
  | { kind: "Unreadable"; detail: string };

const PackListSchema = z.array(z.string());
const EntrySchema = SnapshotManifestSchema.shape.entries.element;
const ENTRY_FIELDS = ["kind", "path", "mode", "uid", "gid", "mtimeSeconds", "mtimeNanos", "sizeBytes", "target"];
const DIGEST_BYTES = 32;
const SMALLEST_PLACEMENT_JSON = '{"digest":"","packDigest":"","offset":0,"length":1}'.length + 4 * DIGEST_BYTES;
const BYTES_PER_PLACEMENT = DIGEST_BYTES + 8 + 4 + 4 + 4;
const CACHED_PACK_LISTS = 1000;
export const MAX_INDEX_BYTES = 32 * 1024 * 1024;

export const packKey = (tenantId: string, packDigest: string): string => `${tenantId}/packs/${packDigest}`;

export const packListKey = (storageKey: string): string => `${storageKey}.packs`;

export const indexBytesOf = (root: Placement[]): number =>
  Math.floor(root.reduce((total, placement) => total + placement.length, 0) / SMALLEST_PLACEMENT_JSON) *
  BYTES_PER_PLACEMENT;

const issues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const remember = <T>(cache: Map<string, T>, key: string, value: T, limit: number): T => {
  cache.delete(key);
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

const nibble = (code: number): number => (code <= 57 ? code - 48 : code - 87);

const hexInto = (hex: string, into: Uint8Array, at: number): void => {
  for (let byte = 0; byte < DIGEST_BYTES; byte++) {
    into[at + byte] = (nibble(hex.charCodeAt(byte * 2)) << 4) | nibble(hex.charCodeAt(byte * 2 + 1));
  }
};

type PlacementSink = { add(placement: Placement): string | undefined };

class PackSink implements PlacementSink {
  readonly packs = new Set<string>();

  add(placement: Placement): undefined {
    this.packs.add(placement.packDigest);
  }
}

class IndexSink implements PlacementSink {
  private readonly digests: Uint8Array;
  private readonly offsets: Float64Array;
  private readonly lengths: Uint32Array;
  private readonly packOf: Uint32Array;
  private readonly packAt = new Map<string, number>();
  private count = 0;

  constructor(capacity: number) {
    this.digests = new Uint8Array(capacity * DIGEST_BYTES);
    this.offsets = new Float64Array(capacity);
    this.lengths = new Uint32Array(capacity);
    this.packOf = new Uint32Array(capacity);
  }

  add(placement: Placement): string | undefined {
    if (this.count === this.offsets.length) {
      return `more chunk placements than ${this.offsets.length}, the most its byte size can hold`;
    }
    const pack = this.packAt.get(placement.packDigest) ?? this.packAt.size;
    this.packAt.set(placement.packDigest, pack);
    hexInto(placement.digest, this.digests, this.count * DIGEST_BYTES);
    this.offsets[this.count] = placement.offset;
    this.lengths[this.count] = placement.length;
    this.packOf[this.count] = pack;
    this.count += 1;
    return undefined;
  }

  index(): SnapshotIndex {
    return SnapshotIndex.of(this.digests, [...this.packAt.keys()], this.packOf, this.offsets, this.lengths, this.count);
  }
}

export class SnapshotIndex {
  private readonly digests: Uint8Array;
  private readonly packs: string[];
  private readonly packOf: Uint32Array;
  private readonly offsets: Float64Array;
  private readonly lengths: Uint32Array;
  private readonly order: Uint32Array;

  private constructor(
    digests: Uint8Array,
    packs: string[],
    packOf: Uint32Array,
    offsets: Float64Array,
    lengths: Uint32Array,
    order: Uint32Array,
  ) {
    this.digests = digests;
    this.packs = packs;
    this.packOf = packOf;
    this.offsets = offsets;
    this.lengths = lengths;
    this.order = order;
  }

  static of(
    digests: Uint8Array,
    packs: string[],
    packOf: Uint32Array,
    offsets: Float64Array,
    lengths: Uint32Array,
    count: number,
  ): SnapshotIndex {
    const order = new Uint32Array(count);
    for (let slot = 0; slot < count; slot++) order[slot] = slot;
    order.sort((left, right) => SnapshotIndex.compare(digests, left, digests, right * DIGEST_BYTES) || left - right);
    return new SnapshotIndex(digests, packs, packOf, offsets, lengths, order);
  }

  private static compare(digests: Uint8Array, slot: number, other: Uint8Array, at: number): number {
    const start = slot * DIGEST_BYTES;
    for (let byte = 0; byte < DIGEST_BYTES; byte++) {
      const difference = (digests[start + byte] as number) - (other[at + byte] as number);
      if (difference !== 0) return difference;
    }
    return 0;
  }

  get bytes(): number {
    return (
      this.digests.byteLength +
      this.packOf.byteLength +
      this.offsets.byteLength +
      this.lengths.byteLength +
      this.order.byteLength
    );
  }

  find(digest: string): Placement | undefined {
    const at = this.first(digest);
    return at === undefined ? undefined : this.placement(this.order[at] as number, digest);
  }

  holds(placement: Placement): boolean {
    const wanted = new Uint8Array(DIGEST_BYTES);
    hexInto(placement.digest, wanted, 0);
    const first = this.first(placement.digest);
    if (first === undefined) return false;
    for (let at = first; at < this.order.length; at++) {
      const slot = this.order[at] as number;
      if (SnapshotIndex.compare(this.digests, slot, wanted, 0) !== 0) return false;
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

  private placement(slot: number, digest: string): Placement {
    return {
      digest,
      packDigest: this.packs[this.packOf[slot] as number] as string,
      offset: this.offsets[slot] as number,
      length: this.lengths[slot] as number,
    };
  }

  private first(digest: string): number | undefined {
    if (!/^[0-9a-f]{64}$/.test(digest)) return undefined;
    const wanted = new Uint8Array(DIGEST_BYTES);
    hexInto(digest, wanted, 0);
    let low = 0;
    let high = this.order.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (SnapshotIndex.compare(this.digests, this.order[middle] as number, wanted, 0) < 0) low = middle + 1;
      else high = middle;
    }
    if (low >= this.order.length) return undefined;
    return SnapshotIndex.compare(this.digests, this.order[low] as number, wanted, 0) === 0 ? low : undefined;
  }
}

class ManifestStream {
  private readonly parser: JSONParser;
  private readonly sink: PlacementSink;
  private entryAt: unknown;
  private entry: Record<string, unknown> = {};
  private failure: string | undefined;

  constructor(sink: PlacementSink) {
    this.sink = sink;
    this.parser = new JSONParser({
      paths: ["$.entries.*.chunks.*", ...ENTRY_FIELDS.map((field) => `$.entries.*.${field}`)],
      keepStack: false,
    });
    this.parser.onError = (error: Error) => {
      this.failure ??= `it is no JSON: ${error.message}`;
    };
    this.parser.onValue = ({ value, key, stack }) => {
      if (this.failure !== undefined) return;
      const entryAt = stack[2]?.key;
      if (entryAt !== this.entryAt) this.closeEntry(entryAt);
      if (typeof key === "string") {
        this.entry[key] = value;
        return;
      }
      const placement = ChunkPlacementSchema.safeParse(value);
      if (!placement.success) {
        this.failure = `it places a chunk wrongly: ${issues(placement.error)}`;
        return;
      }
      this.failure = this.sink.add(placement.data);
    };
  }

  write(bytes: Uint8Array): string | undefined {
    if (this.failure === undefined) this.parser.write(bytes);
    return this.failure;
  }

  end(): string | undefined {
    if (this.failure !== undefined) return this.failure;
    if (!this.parser.isEnded) return "it ends before its JSON does";
    this.closeEntry(undefined);
    return this.failure;
  }

  private closeEntry(next: unknown): void {
    if (this.entryAt !== undefined) {
      const parsed = EntrySchema.safeParse({ ...this.entry, chunks: [] });
      if (!parsed.success) this.failure ??= `entry ${String(this.entryAt)} is no entry: ${issues(parsed.error)}`;
    }
    this.entryAt = next;
    this.entry = {};
  }
}

export class SnapshotManifests {
  private readonly indexes = new Map<string, SnapshotIndex>();
  private readonly loading = new Map<string, Promise<ManifestRead<SnapshotIndex>>>();
  private readonly packLists = new Map<string, ReadonlySet<string>>();
  private parsing: Promise<unknown> = Promise.resolve();

  async index(store: R2Bucket, tenantId: string, storageKey: string): Promise<ManifestRead<SnapshotIndex>> {
    const held = this.indexes.get(storageKey);
    if (held !== undefined) return { kind: "Read", value: remember(this.indexes, storageKey, held, Infinity) };
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
    if (held !== undefined)
      return { kind: "Read", value: remember(this.packLists, storageKey, held, CACHED_PACK_LISTS) };
    const listed = await store.get(packListKey(storageKey));
    if (listed !== null) {
      const parsed = PackListSchema.safeParse(parsedJson(await listed.text()));
      if (!parsed.success) {
        return { kind: "Unreadable", detail: `the pack list of ${storageKey} is no list: ${issues(parsed.error)}` };
      }
      return { kind: "Read", value: remember(this.packLists, storageKey, new Set(parsed.data), CACHED_PACK_LISTS) };
    }
    const read = await this.oneAtATime(async (): Promise<ManifestRead<ReadonlySet<string>>> => {
      const root = await this.root(store, storageKey);
      if (root.kind !== "Read") return root;
      if (indexBytesOf(root.value) > MAX_INDEX_BYTES) {
        console.error(
          `snapshot ${storageKey} has a manifest whose index would pass the ${MAX_INDEX_BYTES} bytes the control plane holds, so no restore or dedup can use it; retention keeps the packs it names`,
        );
      }
      const sink = new PackSink();
      const streamed = await this.stream(store, tenantId, storageKey, root.value, sink);
      if (streamed !== undefined) return { kind: "Unreadable", detail: streamed };
      for (const placement of root.value) sink.packs.add(placement.packDigest);
      return { kind: "Read", value: sink.packs };
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
    const root = await this.root(store, storageKey);
    if (root.kind !== "Read") return root;
    const needed = indexBytesOf(root.value);
    if (needed > MAX_INDEX_BYTES) {
      return {
        kind: "Unreadable",
        detail: `the manifest of ${storageKey} would need an index of ${needed} bytes, above the ${MAX_INDEX_BYTES} bytes the control plane holds`,
      };
    }
    let cached = [...this.indexes.values()].reduce((total, index) => total + index.bytes, 0);
    for (const [key, index] of this.indexes) {
      if (cached + needed <= MAX_INDEX_BYTES) break;
      this.indexes.delete(key);
      cached -= index.bytes;
    }
    const sink = new IndexSink(Math.floor(needed / BYTES_PER_PLACEMENT));
    const streamed = await this.stream(store, tenantId, storageKey, root.value, sink);
    if (streamed !== undefined) return { kind: "Unreadable", detail: streamed };
    return { kind: "Read", value: remember(this.indexes, storageKey, sink.index(), Infinity) };
  }

  private async root(store: R2Bucket, storageKey: string): Promise<ManifestRead<Placement[]>> {
    const root = await store.get(storageKey);
    if (root === null) return { kind: "Gone", detail: `object storage holds no snapshot root under ${storageKey}` };
    const parsed = SnapshotRootSchema.safeParse(parsedJson(await root.text()));
    if (!parsed.success) {
      return { kind: "Unreadable", detail: `${storageKey} is no snapshot root: ${issues(parsed.error)}` };
    }
    return { kind: "Read", value: parsed.data.manifest };
  }

  private async stream(
    store: R2Bucket,
    tenantId: string,
    storageKey: string,
    root: Placement[],
    sink: PlacementSink,
  ): Promise<string | undefined> {
    const manifest = new ManifestStream(sink);
    for (const range of ranges(root)) {
      const body = await store.get(packKey(tenantId, range.packDigest), {
        range: { offset: range.offset, length: range.length },
      });
      if (body === null) {
        return `the manifest of ${storageKey} lies in pack ${range.packDigest}, which object storage does not hold`;
      }
      const reader = body.body.getReader();
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        const failure = manifest.write(part.value);
        if (failure !== undefined) {
          await reader.cancel();
          return `the manifest of ${storageKey} is unreadable: ${failure}`;
        }
      }
    }
    const failure = manifest.end();
    return failure === undefined ? undefined : `the manifest of ${storageKey} is unreadable: ${failure}`;
  }
}
