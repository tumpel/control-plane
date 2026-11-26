import { sql as query } from "drizzle-orm";
import { durableDb } from "./db/client.ts";
import { PackListSchema, packListKey } from "./snapshot-manifests.ts";

export const CLEANUP_DELAY_MS = 10 * 60_000;
export const PACK_GRACE_MS = 60 * 60_000;
const MARK_BYTES = 1024 * 1024;
const SWEEP_PAGE = 1000;

type Input = { snapshot_id: string; storage_key: string; stored: number };

type Run = {
  startedAt: number;
  inputs: Input[];
  known: Set<string>;
  next: number;
  marked: Set<string>;
  after: string | undefined;
  again: boolean;
};

const inputs = (storage: DurableObjectStorage): Input[] =>
  durableDb(storage, {}).all<Input>(query`SELECT snapshot_id, storage_key, 1 AS stored FROM snapshots
    UNION ALL SELECT snapshot_id, storage_key, 0 FROM snapshot_failures WHERE storage_key != ''`);

const held = (storage: DurableObjectStorage, input: Input): boolean =>
  durableDb(storage, {}).get(query`SELECT 1 FROM snapshots WHERE snapshot_id = ${input.snapshot_id}`) !== undefined;

const mark = async (
  storage: DurableObjectStorage,
  store: R2Bucket,
  marked: Set<string>,
  input: Input,
): Promise<number> => {
  const listed = await store.get(packListKey(input.storage_key));
  if (listed === null && (input.stored === 0 || !held(storage, input))) return 0;
  if (listed === null) throw new Error(`snapshot ${input.storage_key} is stored but has no pack list to mark`);
  for (const packDigest of PackListSchema.parse(JSON.parse(await listed.text()))) marked.add(packDigest);
  return listed.size;
};

export class PackCleanup {
  private run: Run | null = null;

  async request(storage: DurableObjectStorage, now: number): Promise<void> {
    if (this.run !== null) {
      this.run.again = true;
      return;
    }
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
      };
      return ctx.storage.setAlarm(now);
    }
    if (run.next < run.inputs.length) {
      for (let read = 0; run.next < run.inputs.length && read < MARK_BYTES; run.next += 1) {
        const input = run.inputs[run.next];
        if (input !== undefined) read += await mark(ctx.storage, store, run.marked, input);
      }
      return ctx.storage.setAlarm(now);
    }
    const prefix = `${tenantId}/packs/`;
    const listed = await store.list({ prefix, startAfter: run.after, limit: SWEEP_PAGE });
    await ctx.blockConcurrencyWhile(async () => {
      for (const input of inputs(ctx.storage)) {
        if (run.known.has(input.snapshot_id)) continue;
        await mark(ctx.storage, store, run.marked, input);
        run.known.add(input.snapshot_id);
      }
      const doomed = listed.objects
        .filter((object) => object.uploaded.getTime() < run.startedAt - PACK_GRACE_MS)
        .filter((object) => !run.marked.has(object.key.slice(prefix.length)))
        .map((object) => object.key);
      if (doomed.length > 0) await store.delete(doomed);
    });
    run.after = listed.objects.at(-1)?.key ?? run.after;
    if (listed.truncated) return ctx.storage.setAlarm(now);
    this.run = null;
    if (run.again) await ctx.storage.setAlarm(now + CLEANUP_DELAY_MS);
  }
}
