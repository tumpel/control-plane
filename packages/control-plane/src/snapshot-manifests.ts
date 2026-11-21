import JSONParser from "@streamparser/json/jsonparser.js";
import { ChunkPlacementSchema, SnapshotManifestSchema, SnapshotRootSchema } from "@tumpel/schemas";
import { z } from "zod";
import { errorOf } from "./backoff.ts";

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
const PACK_NAME_BYTES = 128;
const LIVE_PAGE = 100;
export const MAX_PACKS_PER_MANIFEST = 16_384;
export const MAX_INDEX_BYTES = 32 * 1024 * 1024;

export const packKey = (tenantId: string, packDigest: string): string => `${tenantId}/packs/${packDigest}`;

export const packListKey = (storageKey: string): string => `${storageKey}.packs`;

export const indexBytesOf = (root: Placement[]): number =>
  Math.floor(root.reduce((total, placement) => total + placement.length, 0) / SMALLEST_PLACEMENT_JSON) *
    BYTES_PER_PLACEMENT +
  MAX_PACKS_PER_MANIFEST * PACK_NAME_BYTES;

const issues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const remember = <T>(cache: Map<string, T>, key: string, value: T): T => {
  cache.delete(key);
  cache.set(key, value);
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
    if (pack === MAX_PACKS_PER_MANIFEST) return `chunks in more than ${MAX_PACKS_PER_MANIFEST} packs`;
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
      this.order.byteLength +
      this.packs.length * PACK_NAME_BYTES
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
  private parsing: Promise<unknown> = Promise.resolve();

  async index(store: R2Bucket, tenantId: string, storageKey: string): Promise<ManifestRead<SnapshotIndex>> {
    const held = this.indexes.get(storageKey);
    if (held !== undefined) return { kind: "Read", value: remember(this.indexes, storageKey, held) };
    const loading = this.loading.get(storageKey);
    if (loading !== undefined) return loading;
    const load = this.oneAtATime(() => this.load(store, tenantId, storageKey)).finally(() =>
      this.loading.delete(storageKey),
    );
    this.loading.set(storageKey, load);
    return load;
  }

  async packs(store: R2Bucket, tenantId: string, storageKey: string): Promise<ManifestRead<ReadonlySet<string>>> {
    const listed = await store.get(packListKey(storageKey));
    if (listed !== null) {
      const parsed = PackListSchema.safeParse(parsedJson(await listed.text()));
      if (!parsed.success) {
        return { kind: "Unreadable", detail: `the pack list of ${storageKey} is no list: ${issues(parsed.error)}` };
      }
      return { kind: "Read", value: new Set(parsed.data) };
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
    return read;
  }

  forget(storageKey: string): void {
    this.indexes.delete(storageKey);
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
    for (const placement of root.value) {
      const failure = sink.add(placement);
      if (failure !== undefined)
        return { kind: "Unreadable", detail: `the manifest of ${storageKey} holds ${failure}` };
    }
    return { kind: "Read", value: remember(this.indexes, storageKey, sink.index()) };
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

export type LiveNames = { has(packDigest: string): boolean; unreadable: string | undefined };

type LiveState = { counts: Map<string, number>; members: Set<string>; unreadable: Map<string, string> };

const LivePacksSchema = z.object({
  members: z.array(z.string()),
  counts: z.array(z.tuple([z.string(), z.number().int().min(1)])),
});

export const livePacksKey = (tenantId: string): string => `${tenantId}/live-packs.json`;

const counted = (state: LiveState, storageKey: string, packs: ReadonlySet<string>): void => {
  state.members.add(storageKey);
  for (const packDigest of packs) state.counts.set(packDigest, (state.counts.get(packDigest) ?? 0) + 1);
};

const uncounted = (state: LiveState, storageKey: string, packs: ReadonlySet<string>): void => {
  state.members.delete(storageKey);
  for (const packDigest of packs) {
    const count = (state.counts.get(packDigest) ?? 0) - 1;
    if (count > 0) state.counts.set(packDigest, count);
    else state.counts.delete(packDigest);
  }
};

export class LivePacks {
  private readonly manifests: SnapshotManifests;
  private readonly livePage: (after: string, limit: number) => string[];
  private state: LiveState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(manifests: SnapshotManifests, livePage: (after: string, limit: number) => string[]) {
    this.manifests = manifests;
    this.livePage = livePage;
  }

  async names(store: R2Bucket, tenantId: string): Promise<LiveNames> {
    const state = await this.turn(() => this.loaded(store, tenantId));
    const [unreadable] = state.unreadable.values();
    return { has: (packDigest) => state.counts.has(packDigest), unreadable };
  }

  add(store: R2Bucket, tenantId: string, storageKey: string, packs: ReadonlySet<string>): Promise<void> {
    return this.turn(async () => {
      const state = this.state;
      if (state === null || state.members.has(storageKey)) return;
      counted(state, storageKey, packs);
      await this.persist(store, tenantId, state);
    });
  }

  release(store: R2Bucket, tenantId: string, storageKeys: string[]): Promise<void> {
    return this.turn(() =>
      this.released(store, tenantId, storageKeys).catch((error: unknown) => {
        this.state = null;
        console.error(
          `tenant ${tenantId} could not release snapshots ${storageKeys.join(", ")} from its live pack names, so they are rebuilt from the snapshots table on next use: ${errorOf(error).message}`,
        );
      }),
    );
  }

  private async released(store: R2Bucket, tenantId: string, storageKeys: string[]): Promise<void> {
    const state = await this.loaded(store, tenantId);
    let changed = false;
    for (const storageKey of storageKeys) {
      if (state.unreadable.delete(storageKey) || !state.members.has(storageKey)) continue;
      const read = await this.manifests.packs(store, tenantId, storageKey);
      if (read.kind !== "Read") throw new Error(`snapshot ${storageKey} has no readable pack list: ${read.detail}`);
      uncounted(state, storageKey, read.value);
      changed = true;
    }
    if (changed) await this.persist(store, tenantId, state);
  }

  private async loaded(store: R2Bucket, tenantId: string): Promise<LiveState> {
    if (this.state !== null) return this.state;
    const state = (await this.reconciled(store, tenantId)) ?? (await this.rebuilt(store, tenantId));
    this.state = state;
    return state;
  }

  private async reconciled(store: R2Bucket, tenantId: string): Promise<LiveState | null> {
    const object = await store.get(livePacksKey(tenantId));
    if (object === null) return null;
    const parsed = LivePacksSchema.safeParse(parsedJson(await object.text()));
    if (!parsed.success) {
      console.error(
        `tenant ${tenantId} holds live pack names that do not parse, so they are rebuilt: ${issues(parsed.error)}`,
      );
      return null;
    }
    const state: LiveState = {
      counts: new Map(parsed.data.counts),
      members: new Set(parsed.data.members),
      unreadable: new Map(),
    };
    const live = new Set<string>();
    let changed = false;
    await this.eachLive(async (storageKey) => {
      live.add(storageKey);
      if (state.members.has(storageKey)) return;
      changed = (await this.counts(store, tenantId, state, storageKey)) || changed;
    });
    for (const member of [...state.members]) {
      if (live.has(member)) continue;
      const read = await this.manifests.packs(store, tenantId, member);
      if (read.kind !== "Read") return null;
      uncounted(state, member, read.value);
      changed = true;
    }
    if (changed) await this.persist(store, tenantId, state);
    return state;
  }

  private async rebuilt(store: R2Bucket, tenantId: string): Promise<LiveState> {
    const state: LiveState = { counts: new Map(), members: new Set(), unreadable: new Map() };
    await this.eachLive(async (storageKey) => {
      await this.counts(store, tenantId, state, storageKey);
    });
    await this.persist(store, tenantId, state);
    return state;
  }

  private async counts(store: R2Bucket, tenantId: string, state: LiveState, storageKey: string): Promise<boolean> {
    const read = await this.manifests.packs(store, tenantId, storageKey);
    if (read.kind === "Read") counted(state, storageKey, read.value);
    if (read.kind === "Unreadable") {
      state.unreadable.set(
        storageKey,
        `snapshot ${storageKey} is live but its packs cannot be read, so retention keeps every pack until it can: ${read.detail}`,
      );
    }
    return read.kind === "Read";
  }

  private async eachLive(visit: (storageKey: string) => Promise<void>): Promise<void> {
    for (let page = this.livePage("", LIVE_PAGE); page.length > 0; page = this.livePage(page.at(-1) ?? "", LIVE_PAGE)) {
      for (const storageKey of page) await visit(storageKey);
    }
  }

  private persist(store: R2Bucket, tenantId: string, state: LiveState): Promise<void> {
    const body = JSON.stringify({ members: [...state.members], counts: [...state.counts] });
    return store.put(livePacksKey(tenantId), body).then(
      () => undefined,
      (error: unknown) =>
        console.error(
          `tenant ${tenantId} could not store its live pack names, so the next restart reconciles them with the snapshots table: ${errorOf(error).message}`,
        ),
    );
  }

  private turn<T>(run: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(run);
    this.queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }
}
