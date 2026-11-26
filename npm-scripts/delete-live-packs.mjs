import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { listedKeys, retrying, withStageBucket } from "./r2-stage.mjs";

const LIVE_PACKS = /^[^/]+\/live-packs\.json$/;

export const deleteLivePacks = async (bucket, wait, log, deleting) => {
  const store = retrying(bucket, wait);
  for (const key of await listedKeys(store, LIVE_PACKS)) {
    if (deleting) await store.delete(key);
    log(`${deleting ? "deleted" : "would delete"} ${key}`);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const usage = "node npm-scripts/delete-live-packs.mjs <dev|production> [--delete]";
  const [stage, flag] = process.argv.slice(2);
  if (flag !== undefined && flag !== "--delete") throw new Error(`usage: ${usage}`);
  await withStageBucket(usage, stage, (bucket) =>
    deleteLivePacks(bucket, setTimeout, console.log, flag === "--delete"),
  );
}
