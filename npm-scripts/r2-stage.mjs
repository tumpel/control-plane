import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { startRemoteProxySession, unstable_readConfig } from "wrangler";

const RETRIES = 10;
const FIRST_BACKOFF_MS = 250;
const LIST_PAGE = 1000;
const STAGES = { dev: "dev", production: undefined };

export const retrying = (store, wait) => {
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
    delete: (key) => call("delete", key, () => store.delete(key)),
    list: (options) => call("list", `the page after ${options.cursor ?? "the start"}`, () => store.list(options)),
  };
};

export const listedKeys = async (store, matches) => {
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ limit: LIST_PAGE, cursor });
    for (const { key } of page.objects) if (matches.test(key)) keys.push(key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
};

export const withStageBucket = async (usage, stage, run) => {
  if (!(stage in STAGES)) throw new Error(`usage: ${usage}`);
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
    await run(await miniflare.getR2Bucket("STORE"));
  } finally {
    await miniflare.dispose();
    await session.dispose();
  }
};
