import { sql as query } from "drizzle-orm";
import { durableDb } from "./db/client.ts";
import { draftKey, PackListSchema, packList, packListKey, parsedDraft, snapshotDraft } from "./snapshot-manifests.ts";

export const CLEANUP_DELAY_MS = 10 * 60_000;
export const PACK_GRACE_MS = 60 * 60_000;
const MARK_BYTES = 1024 * 1024;
const MARK_INPUTS = 100;
const DRAFT_BYTES = 4 * 1024 * 1024;
const LOCKED_DRAFT_BYTES = 256 * 1024;
const SWEEP_PAGE = 1000;
const PACK_LIST_ENTRY_BYTES = 67;

type Input = { snapshot_id: string; storage_key: string; stored: number };

type Run = {
  startedAt: number;
  inputs: Input[];
  known: Set<string>;
  next: number;
  marked: Set<string>;
  after: string | undefined;
  again: boolean;
  draftEtags: Map<string, string>;
  unmarkedDrafts: string[] | null;
};

type ChangedDraft = { storageKey: string; draft: R2ObjectBody };

const inputs = (storage: DurableObjectStorage): Input[] =>
  durableDb(storage, {}).all<Input>(query`SELECT snapshot_id, storage_key, 1 AS stored FROM snapshots
    UNION ALL SELECT snapshot_id, storage_key, 0 FROM snapshot_failures WHERE storage_key != ''`);

const held = (storage: DurableObjectStorage, input: Input): boolean =>
  durableDb(storage, {}).get(query`SELECT 1 FROM snapshots WHERE snapshot_id = ${input.snapshot_id}`) !== undefined;

const failedPackList = async (store: R2Bucket, input: Input): Promise<string[]> => {
  const listed = await packList(store, input.storage_key);
  if (listed === null) return [];
  if (listed.kind !== "Read") throw new Error(listed.detail);
  return [...listed.value];
};

const mark = async (
  storage: DurableObjectStorage,
  store: R2Bucket,
  marked: Set<string>,
  input: Input,
): Promise<number> => {
  if (input.stored === 0) {
    const packs = (await snapshotDraft(store, input.storage_key))?.packs ?? (await failedPackList(store, input));
    for (const packDigest of packs) marked.add(packDigest);
    return packs.length * PACK_LIST_ENTRY_BYTES;
  }
  const listed = await store.get(packListKey(input.storage_key));
  if (listed === null && !held(storage, input)) return 0;
  if (listed === null) throw new Error(`snapshot ${input.storage_key} is stored but has no pack list to mark`);
  for (const packDigest of PackListSchema.parse(JSON.parse(await listed.text()))) marked.add(packDigest);
  return listed.size;
};

const openRequests = (storage: DurableObjectStorage): string[] =>
  durableDb(storage, {})
    .all<{ storage_key: string }>(query`SELECT storage_key FROM snapshot_requests`)
    .map((request) => request.storage_key);

const changedDraft = async (
  store: R2Bucket,
  etags: Map<string, string>,
  storageKey: string,
): Promise<ChangedDraft | null> => {
  const etag = etags.get(storageKey);
  const draft = await store.get(draftKey(storageKey), { onlyIf: etag === undefined ? {} : { etagDoesNotMatch: etag } });
  if (draft === null || !("body" in draft)) return null;
  return { storageKey, draft };
};

const markDraft = async (run: Run, changed: ChangedDraft): Promise<void> => {
  for (const packDigest of parsedDraft(changed.storageKey, await changed.draft.text()).packs)
    run.marked.add(packDigest);
  run.draftEtags.set(changed.storageKey, changed.draft.etag);
};

export class PackCleanup {
  private run: Run | null = null;

  async request(storage: DurableObjectStorage, now: number): Promise<void> {
    if (this.run !== null) this.run.again = true;
    if ((await storage.getAlarm()) === null) await storage.setAlarm(now + CLEANUP_DELAY_MS);
  }

  async step(ctx: DurableObjectState, store: R2Bucket, tenantId: string, now: number): Promise<void> {
    const run = this.run;
    if (run === null) {
      const found = inputs(ctx.storage);
      this.run = {
        startedAt: now,
        inputs: found,
        known: new Set(found.map((input) => input.snapshot_id)),
        next: 0,
        marked: new Set(),
        after: undefined,
        again: false,
        draftEtags: new Map(),
        unmarkedDrafts: null,
      };
      return ctx.storage.setAlarm(now);
    }
    if (run.next < run.inputs.length) {
      const last = run.next + MARK_INPUTS;
      for (let read = 0; run.next < Math.min(run.inputs.length, last) && read < MARK_BYTES; run.next += 1) {
        const input = run.inputs[run.next];
        if (input !== undefined) read += await mark(ctx.storage, store, run.marked, input);
      }
      return ctx.storage.setAlarm(now);
    }
    run.unmarkedDrafts ??= openRequests(ctx.storage);
    if (run.unmarkedDrafts.length > 0) {
      for (let read = 0; read < DRAFT_BYTES; ) {
        const storageKey = run.unmarkedDrafts.pop();
        if (storageKey === undefined) break;
        const changed = await changedDraft(store, run.draftEtags, storageKey);
        if (changed === null) continue;
        read += changed.draft.size;
        await markDraft(run, changed);
      }
      return ctx.storage.setAlarm(now);
    }
    const prefix = `${tenantId}/packs/`;
    const listed = await store.list({ prefix, startAfter: run.after, limit: SWEEP_PAGE });
    const swept = await ctx.blockConcurrencyWhile(async () => {
      for (const input of inputs(ctx.storage)) {
        if (run.known.has(input.snapshot_id)) continue;
        await mark(ctx.storage, store, run.marked, input);
        run.known.add(input.snapshot_id);
      }
      const changed = (
        await Promise.all(openRequests(ctx.storage).map((key) => changedDraft(store, run.draftEtags, key)))
      ).filter((draft) => draft !== null);
      if (changed.reduce((bytes, { draft }) => bytes + draft.size, 0) > LOCKED_DRAFT_BYTES) {
        run.unmarkedDrafts = changed.map(({ storageKey }) => storageKey);
        return false;
      }
      for (const draft of changed) await markDraft(run, draft);
      const doomed = listed.objects
        .filter((object) => object.uploaded.getTime() < run.startedAt - PACK_GRACE_MS)
        .filter((object) => !run.marked.has(object.key.slice(prefix.length)))
        .map((object) => object.key);
      if (doomed.length > 0) await store.delete(doomed);
      return true;
    });
    if (!swept) return ctx.storage.setAlarm(now);
    run.unmarkedDrafts = null;
    run.after = listed.objects.at(-1)?.key ?? run.after;
    if (listed.truncated) return ctx.storage.setAlarm(now);
    this.run = null;
    if (run.again) await ctx.storage.setAlarm(now + CLEANUP_DELAY_MS);
  }
}
