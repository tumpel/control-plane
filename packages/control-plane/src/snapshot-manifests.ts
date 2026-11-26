import JSONParser from "@streamparser/json/jsonparser.js";
import { ChunkPlacementSchema, SnapshotManifestSchema, SnapshotRootSchema } from "@tumpel/schemas";
import { z } from "zod";

export type Placement = z.infer<typeof ChunkPlacementSchema>;

export type ManifestRead<T> =
  | { kind: "Read"; value: T }
  | { kind: "Gone"; detail: string }
  | { kind: "Unreadable"; detail: string };

export const PackListSchema = z.array(z.string());
const EntrySchema = SnapshotManifestSchema.shape.entries.element;
const ENTRY_FIELDS = ["kind", "path", "mode", "uid", "gid", "mtimeSeconds", "mtimeNanos", "sizeBytes", "target"];
const LIVE_PAGE = 100;
export const MAX_PACKS_PER_MANIFEST = 16_384;
export const STORE_DELETE_BATCH = 1000;

export const packKey = (tenantId: string, packDigest: string): string => `${tenantId}/packs/${packDigest}`;

export const packListKey = (storageKey: string): string => `${storageKey}.packs`;

export const draftKey = (storageKey: string): string => `${storageKey}.draft`;

const issues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

const packList = async (
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
});

type SnapshotDraft = z.infer<typeof SnapshotDraftSchema>;

export const mergedDraft = (
  draft: SnapshotDraft | null,
  part: number,
  packs: string[],
): { kind: "Merged"; draft: SnapshotDraft } | { kind: "Refused"; detail: string } => {
  const continues = draft !== null && (part === draft.lastPart || part === draft.lastPart + 1);
  if (part !== 1 && !continues) {
    return {
      kind: "Refused",
      detail: `but the control plane expects part ${draft === null ? 1 : draft.lastPart + 1}, so the snapshot cannot name its packs`,
    };
  }
  const merged = new Set([...(part === 1 || draft === null ? [] : draft.packs), ...packs]);
  if (merged.size > MAX_PACKS_PER_MANIFEST) {
    return {
      kind: "Refused",
      detail: `which brings it to ${merged.size} packs, above the ${MAX_PACKS_PER_MANIFEST} the control plane indexes, so the snapshot cannot name its packs`,
    };
  }
  return { kind: "Merged", draft: { lastPart: part, packs: [...merged] } };
};

export const snapshotDraft = async (store: R2Bucket, storageKey: string): Promise<SnapshotDraft | null> => {
  const draft = await store.get(draftKey(storageKey));
  if (draft === null) return null;
  const parsed = SnapshotDraftSchema.safeParse(parsedJson(await draft.text()));
  if (!parsed.success) throw new Error(`the pack draft of ${storageKey} does not parse: ${issues(parsed.error)}`);
  return parsed.data;
};

export const snapshotPackSet = async (store: R2Bucket, storageKey: string): Promise<ReadonlySet<string> | null> => {
  const draft = await snapshotDraft(store, storageKey);
  if (draft !== null) return new Set(draft.packs);
  const claimed = await packList(store, storageKey);
  if (claimed === null) return null;
  if (claimed.kind !== "Read") throw new Error(claimed.detail);
  return claimed.value;
};

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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

type PlacementSink = { add(placement: Placement): string | undefined };

class PackSink implements PlacementSink {
  readonly packs = new Set<string>();

  add(placement: Placement): undefined {
    this.packs.add(placement.packDigest);
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
  private parsing: Promise<unknown> = Promise.resolve();

  async packs(store: R2Bucket, tenantId: string, storageKey: string): Promise<ManifestRead<ReadonlySet<string>>> {
    const listed = await packList(store, storageKey);
    if (listed !== null) return listed;
    const read = await this.oneAtATime(async (): Promise<ManifestRead<ReadonlySet<string>>> => {
      const root = await this.root(store, storageKey);
      if (root.kind !== "Read") return root;
      const sink = new PackSink();
      const streamed = await this.stream(store, tenantId, storageKey, root.value, sink);
      if (streamed !== undefined) return { kind: "Unreadable", detail: streamed };
      return { kind: "Read", value: sink.packs };
    });
    if (read.kind !== "Read") return read;
    await store.put(packListKey(storageKey), JSON.stringify([...read.value].sort()));
    return read;
  }

  private oneAtATime<T>(run: () => Promise<T>): Promise<T> {
    const turn = this.parsing.then(run);
    this.parsing = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
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
    for (const placement of root) {
      const failure = sink.add(placement);
      if (failure !== undefined) return `the manifest of ${storageKey} is unreadable: ${failure}`;
    }
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

type LiveState = {
  counts: Map<string, number>;
  members: Set<string>;
  held: Map<string, Map<string, boolean>>;
  unreadable: Map<string, string>;
};

const LivePacksSchema = z.object({
  members: z.array(z.string()),
  counts: z.array(z.tuple([z.string(), z.number().int().min(1)])),
  held: z.array(z.tuple([z.string(), z.array(z.tuple([z.string(), z.boolean()]))])).default([]),
});

type SavedLivePacks = z.infer<typeof LivePacksSchema>;

export const livePacksKey = (tenantId: string): string => `${tenantId}/live-packs.json`;

const increment = (state: LiveState, packDigest: string): void => {
  state.counts.set(packDigest, (state.counts.get(packDigest) ?? 0) + 1);
};

const decrement = (state: LiveState, packDigest: string): string[] => {
  const count = (state.counts.get(packDigest) ?? 0) - 1;
  if (count > 0) state.counts.set(packDigest, count);
  return count <= 0 && state.counts.delete(packDigest) ? [packDigest] : [];
};

const counted = (state: LiveState, storageKey: string, packs: ReadonlySet<string>): void => {
  state.members.add(storageKey);
  for (const packDigest of packs) increment(state, packDigest);
};

const uncounted = (state: LiveState, storageKey: string, packs: ReadonlySet<string>): string[] => {
  state.members.delete(storageKey);
  return [...packs].flatMap((packDigest) => decrement(state, packDigest));
};

const heldFrom = (state: LiveState, saved: SavedLivePacks["held"]): void => {
  for (const [sessionId, packs] of saved) {
    state.held.set(sessionId, new Map(packs));
    for (const [packDigest] of packs) increment(state, packDigest);
  }
};

type Holders = { count: number; uploaded: boolean };

const holders = (state: LiveState): Map<string, Holders> => {
  const found = new Map<string, Holders>();
  for (const packs of state.held.values()) {
    for (const [packDigest, uploaded] of packs) {
      const known = found.get(packDigest) ?? { count: 0, uploaded: false };
      found.set(packDigest, { count: known.count + 1, uploaded: known.uploaded || uploaded });
    }
  }
  return found;
};

const markUploaded = (state: LiveState, packDigest: string): void => {
  for (const packs of state.held.values()) if (packs.has(packDigest)) packs.set(packDigest, true);
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

  add(store: R2Bucket, tenantId: string, storageKey: string, packs: ReadonlySet<string>): Promise<void> {
    return this.turn(async () => {
      const state = this.state;
      if (state === null || state.members.has(storageKey)) return;
      counted(state, storageKey, packs);
      await this.persist(store, tenantId, state);
    });
  }

  hold(store: R2Bucket, tenantId: string, sessionId: string, packDigests: string[]): Promise<string[]> {
    return this.turn(() =>
      this.changing(store, tenantId, async (state) => {
        const held = state.held.get(sessionId) ?? new Map<string, boolean>();
        const unnamed = packDigests.filter((packDigest) => !state.counts.has(packDigest));
        const uploading = packDigests.filter(
          (packDigest) => held.get(packDigest) === false || !state.counts.has(packDigest),
        );
        if (unnamed.length === 0) return uploading;
        for (const packDigest of unnamed) {
          held.set(packDigest, false);
          increment(state, packDigest);
        }
        state.held.set(sessionId, held);
        await this.persist(store, tenantId, state);
        return uploading;
      }),
    );
  }

  claim(store: R2Bucket, tenantId: string, storageKey: string, packs: ReadonlySet<string>): Promise<string | null> {
    return this.turn(() =>
      this.changing(store, tenantId, async (state) => {
        const held = holders(state);
        const sorted = [...packs].sort();
        const gone = sorted.find((packDigest) => !state.counts.has(packDigest));
        if (gone !== undefined) return gone;
        const unproven = sorted.filter((packDigest) => {
          const hold = held.get(packDigest);
          return hold !== undefined && !hold.uploaded && hold.count === state.counts.get(packDigest);
        });
        const found = await Promise.all(unproven.map((packDigest) => store.head(packKey(tenantId, packDigest))));
        const missing = unproven.find((_, at) => found[at] === null);
        if (missing !== undefined) return missing;
        for (const packDigest of unproven) markUploaded(state, packDigest);
        await store.put(packListKey(storageKey), JSON.stringify(sorted));
        if (!state.members.has(storageKey)) counted(state, storageKey, packs);
        await this.persist(store, tenantId, state);
        await store.delete(draftKey(storageKey));
        return null;
      }),
    );
  }

  release(store: R2Bucket, tenantId: string, sessionId: string, storageKeys: string[]): Promise<void> {
    return this.turn(() =>
      this.changing(store, tenantId, async (state) => {
        const freed = await this.released(store, tenantId, state, storageKeys);
        for (const packDigest of state.held.get(sessionId)?.keys() ?? []) freed.push(...decrement(state, packDigest));
        state.held.delete(sessionId);
        const keys = freed.map((packDigest) => packKey(tenantId, packDigest));
        for (let start = 0; start < keys.length; start += STORE_DELETE_BATCH) {
          await store.delete(keys.slice(start, start + STORE_DELETE_BATCH));
        }
        await this.persist(store, tenantId, state);
      }),
    );
  }

  unclaim(store: R2Bucket, tenantId: string, storageKey: string): Promise<void> {
    return this.turn(() =>
      this.changing(store, tenantId, async (state) => {
        await this.released(store, tenantId, state, [storageKey]);
        await this.persist(store, tenantId, state);
      }),
    );
  }

  private async changing<T>(store: R2Bucket, tenantId: string, change: (state: LiveState) => Promise<T>): Promise<T> {
    const state = await this.loaded(store, tenantId);
    return change(state).catch((error: unknown) => {
      this.state = null;
      throw error;
    });
  }

  private async released(
    store: R2Bucket,
    tenantId: string,
    state: LiveState,
    storageKeys: string[],
  ): Promise<string[]> {
    const freed: string[] = [];
    for (const storageKey of storageKeys) {
      if (state.unreadable.delete(storageKey) || !state.members.has(storageKey)) continue;
      const read = await this.manifests.packs(store, tenantId, storageKey);
      if (read.kind === "Gone") {
        state.members.delete(storageKey);
        continue;
      }
      if (read.kind !== "Read") throw new Error(`snapshot ${storageKey} has no readable pack list: ${read.detail}`);
      freed.push(...uncounted(state, storageKey, read.value));
    }
    return freed;
  }

  private async loaded(store: R2Bucket, tenantId: string): Promise<LiveState> {
    if (this.state !== null) return this.state;
    const saved = await this.saved(store, tenantId);
    const state =
      (saved === null ? null : await this.reconciled(store, tenantId, saved)) ??
      (await this.rebuilt(store, tenantId, saved?.held ?? []));
    this.state = state;
    return state;
  }

  private async saved(store: R2Bucket, tenantId: string): Promise<SavedLivePacks | null> {
    const object = await store.get(livePacksKey(tenantId));
    if (object === null) return null;
    const parsed = LivePacksSchema.safeParse(parsedJson(await object.text()));
    if (parsed.success) return parsed.data;
    throw new Error(`tenant ${tenantId} holds live pack names that do not parse: ${issues(parsed.error)}`);
  }

  private async reconciled(store: R2Bucket, tenantId: string, saved: SavedLivePacks): Promise<LiveState | null> {
    const state: LiveState = {
      counts: new Map(saved.counts),
      members: new Set(saved.members),
      held: new Map(saved.held.map(([sessionId, packs]) => [sessionId, new Map(packs)])),
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

  private async rebuilt(store: R2Bucket, tenantId: string, held: SavedLivePacks["held"]): Promise<LiveState> {
    const state: LiveState = { counts: new Map(), members: new Set(), held: new Map(), unreadable: new Map() };
    heldFrom(state, held);
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
    const body = JSON.stringify({
      members: [...state.members],
      counts: [...state.counts],
      held: [...state.held].map(([sessionId, packs]) => [sessionId, [...packs]]),
    });
    return store.put(livePacksKey(tenantId), body).then(() => undefined);
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
