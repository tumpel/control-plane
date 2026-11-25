import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { startRemoteProxySession, unstable_readConfig } from "wrangler";
import { packListKey, SnapshotManifests } from "../packages/control-plane/src/snapshot-manifests.ts";

const RETRIES = 10;
const FIRST_BACKOFF_MS = 250;
const LIST_PAGE = 1000;
const ROOT = /^[^/]+\/[^/]+\/snapshots\/[^/.]+$/;
const STAGES = { dev: "dev", production: undefined };

const retrying = (store, wait) => {
  const call = async (operation, key, run) => {
    for (let retry = 0; ; retry++) {
      try {
        return await run();
      } catch (error) {
        if (retry === RETRIES) {
          throw new Error(
            `R2 refused the ${operation} of ${key} ${RETRIES + 1} times (${error.message}); run the script again once R2 answers`,
          );
        }
        await wait(FIRST_BACKOFF_MS * 2 ** retry);
      }
    }
  };
  return {
    get: (key, options) => call("get", key, () => store.get(key, options)),
    put: (key, value) => call("put", key, () => store.put(key, value)),
    list: (options) => call("list", `the page after ${options.cursor ?? "the start"}`, () => store.list(options)),
  };
};

const unlistedRoots = async (store) => {
  const roots = [];
  const listed = new Set();
  let cursor;
  do {
    const page = await store.list({ limit: LIST_PAGE, cursor });
    for (const { key } of page.objects) {
      if (ROOT.test(key)) roots.push(key);
      if (key.endsWith(".packs")) listed.add(key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return roots.filter((root) => !listed.has(packListKey(root)));
};

export const writePackLists = async (bucket, wait, log) => {
  const store = retrying(bucket, wait);
  const manifests = new SnapshotManifests();
  const unreadable = [];
  for (const storageKey of await unlistedRoots(store)) {
    const read = await manifests.packs(store, storageKey.split("/")[0], storageKey);
    if (read.kind === "Read") log(`wrote the pack list of ${storageKey}: ${read.value.size} packs`);
    if (read.kind === "Gone") log(`skipped ${storageKey}: it was deleted while the script ran`);
    if (read.kind === "Unreadable") unreadable.push(`${storageKey}: ${read.detail}`);
  }
  return unreadable;
};

const main = async (stage) => {
  if (!(stage in STAGES)) throw new Error(`usage: node npm-scripts/write-pack-lists.mjs <dev|production>`);
  const configPath = fileURLToPath(new URL("../packages/control-plane/wrangler.jsonc", import.meta.url));
  const config = unstable_readConfig({ config: configPath, env: STAGES[stage] });
  const bucketName = config.r2_buckets.find((bucket) => bucket.binding === "STORE").bucket_name;
  const session = await startRemoteProxySession({ STORE: { type: "r2_bucket", bucket_name: bucketName } });
  const miniflare = new Miniflare({
    modules: true,
    script: "export default {}",
    r2Buckets: { STORE: { id: bucketName, remoteProxyConnectionString: session.remoteProxyConnectionString } },
  });
  try {
    const unreadable = await writePackLists(await miniflare.getR2Bucket("STORE"), setTimeout, console.log);
    if (unreadable.length === 0) return;
    console.error(`these snapshot roots in ${bucketName} have no readable manifest, so no pack list was written:`);
    for (const line of unreadable) console.error(`  ${line}`);
    console.error("Fix: check each against the tenant's live snapshots; a live one needs its manifest repaired.");
    process.exitCode = 1;
  } finally {
    await miniflare.dispose();
    await session.dispose();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2]);
