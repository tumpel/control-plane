#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const configs = execFileSync("git", ["ls-files", "--", "packages/*/wrangler.jsonc"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const consumers = configs.flatMap((file) => {
  const config = experimental_readRawConfig({ config: `${ROOT}${file}` }).rawConfig;
  const scopes = [["", config], ...Object.entries(config.env ?? {}).map(([name, env]) => [`env.${name}.`, env])];
  return scopes.flatMap(([prefix, scope]) =>
    (scope.queues?.consumers ?? []).map((consumer) => ({
      where: `${file} ${prefix}queues ${consumer.queue}`,
      consumer,
    })),
  );
});

const failures = consumers.filter(
  ({ consumer }) =>
    !Number.isInteger(consumer.max_retries) ||
    typeof consumer.dead_letter_queue !== "string" ||
    consumer.dead_letter_queue === "",
);

if (failures.length > 0) {
  console.error(
    `queue check failed: a queue consumer lacks max_retries or a dead_letter_queue.\n  ${failures.map(({ where }) => where).join("\n  ")}`,
  );
  console.error("Fix: give every consumer in wrangler.jsonc a max_retries and a dead_letter_queue.");
  process.exit(1);
}
console.log(`queues: ${consumers.length} consumers checked, each has max_retries and a dead_letter_queue`);
