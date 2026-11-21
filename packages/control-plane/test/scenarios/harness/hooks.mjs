import { readFile } from "node:fs/promises";

const WORKERS = new URL("./cloudflare-workers.mjs", import.meta.url).href;
const TEXT = /\.(sql|css|sh|jsonc)$/;

const bare = (specifier) => specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier);

export const resolve = async (specifier, context, next) => {
  if (specifier === "cloudflare:workers") return { url: WORKERS, shortCircuit: true };
  if (!bare(specifier)) return next(specifier, context);
  return next(`${specifier}.ts`, context).catch(() => next(`${specifier}/index.ts`, context));
};

export const load = async (url, context, next) => {
  if (TEXT.test(url)) {
    const text = await readFile(new URL(url), "utf8");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  if (url.endsWith(".json") && context.importAttributes?.type !== "json") {
    const text = await readFile(new URL(url), "utf8");
    return { format: "module", source: `export default ${text};`, shortCircuit: true };
  }
  return next(url, context);
};
