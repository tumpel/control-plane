import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIOME = join(ROOT, "node_modules/.bin/biome");

mkdirSync(join(ROOT, ".tmp"), { recursive: true });
const WORKSPACE = mkdtempSync(join(ROOT, ".tmp", "prose-plugin-"));
after(() => rmSync(WORKSPACE, { recursive: true, force: true }));

const { plugins } = JSON.parse(readFileSync(join(ROOT, "biome.json"), "utf8"));
writeFileSync(
  join(WORKSPACE, "biome.json"),
  JSON.stringify({
    root: true,
    plugins: plugins.map((plugin) => ({ ...plugin, path: resolve(ROOT, plugin.path) })),
    linter: { rules: { preset: "none" } },
  }),
);

const pluginMessages = (path, source) => {
  mkdirSync(join(WORKSPACE, path, ".."), { recursive: true });
  writeFileSync(join(WORKSPACE, path), source);
  const { stdout } = spawnSync(BIOME, ["lint", "--reporter=json", path], { cwd: WORKSPACE, encoding: "utf8" });
  return JSON.parse(stdout)
    .diagnostics.filter((diagnostic) => diagnostic.category === "plugin")
    .map((diagnostic) => diagnostic.message);
};

const FIXTURE = `import { plan } from "./rfc-12.ts";
export const gap = "Blocked on G12.";
export const requirement = \`Covers FR-3 for \${plan}\`;
export type Doc = "ADR 4";
export const story = { "Story 7": 1 };
export const issue = /issue #5/;
export const caveat = "Retries stop until the queue is built.";
export const fine = "Wait for G1000 frames, then try again.";
`;

test("the prose plugin names each internal id and caveat in control-plane source", () => {
  assert.deepEqual(pluginMessages("packages/control-plane/src/fixture.ts", FIXTURE), [
    "User-facing text names a gap id. Rewrite it without internal ids; say what the user can do now.",
    "User-facing text names a requirement id. Rewrite it without internal ids; say what the user can do now.",
    "User-facing text names a design document id. Rewrite it without internal ids; say what the user can do now.",
    "User-facing text names a story or issue number. Rewrite it without internal ids; say what the user can do now.",
    "User-facing text names a story or issue number. Rewrite it without internal ids; say what the user can do now.",
    "User-facing text carries a caveat about what is not built yet. Say what the user can do now.",
  ]);
});

test("the prose plugin leaves tests alone", () => {
  assert.deepEqual(pluginMessages("packages/control-plane/src/fixture.test.ts", FIXTURE), []);
});
