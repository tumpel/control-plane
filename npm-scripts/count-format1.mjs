import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { listedKeys, retrying, withStageBucket } from "./r2-stage.mjs";

const ROOT = /^[^/]+\/[^/]+\/snapshots\/[^/.]+$/;
const CHUNK_LIST = "TPCL";

const format1 = async (store, storageKey) => {
  const root = await store.get(storageKey);
  if (root === null) return false;
  const [first] = JSON.parse(await root.text()).manifest;
  if (first === undefined) return true;
  const packKey = `${storageKey.split("/")[0]}/packs/${first.packDigest}`;
  const magic = await store.get(packKey, { range: { offset: first.offset, length: CHUNK_LIST.length } });
  return magic === null || (await magic.text()) !== CHUNK_LIST;
};

export const countFormat1 = async (bucket, wait, log) => {
  const store = retrying(bucket, wait);
  let count = 0;
  for (const storageKey of await listedKeys(store, ROOT)) {
    if (!(await format1(store, storageKey))) continue;
    log(storageKey);
    count += 1;
  }
  return count;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await withStageBucket("node npm-scripts/count-format1.mjs <dev|production>", process.argv[2], async (bucket) => {
    const count = await countFormat1(bucket, setTimeout, console.log);
    console.log(`${count} live snapshots have a manifest that is not a chunk list`);
  });
}
