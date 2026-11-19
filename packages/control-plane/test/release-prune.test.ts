import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createTestHarness, type TestHarness } from "wrangler";
import { ARTIFACT_GRACE_MS, type PrunedBucket, pruneReleases } from "../src/release-prune.ts";
import type { ReleaseManifest } from "../src/releases.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "./release-fixture.ts";

let server: TestHarness;

before(async () => {
  server = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [{ configPath: "./wrangler.jsonc" }],
  });
  await server.listen();
});

after(async () => {
  await server?.close();
});

const oci = (config: string, layer: string): string =>
  JSON.stringify({ config: { digest: `sha256:${config}` }, layers: [{ digest: `sha256:${layer}` }] });

test("a published release deletes the artifacts that neither the newest five releases nor images.json name, once past the grace period", async () => {
  const bucket = (await server.getWorker<{ RELEASES: PrunedBucket }>().getEnv()).RELEASES;
  const current = CLAUDE_CODE_AMD64_RELEASE;
  const [image] = current.images;
  const [layer] = current.harnessLayers;
  assert.ok(image && layer);
  const old: ReleaseManifest = {
    ...current,
    releaseVersion: "0.1.0",
    images: [{ ...image, imageDigest: "7".repeat(64), ociDigest: "0".repeat(64) }],
    harnessLayers: [{ ...layer, layerDigest: "8".repeat(64) }],
  };
  const imageDir = `images/ClaudeCode/${image.harnessVersion}/amd64`;
  const ociDir = `oci/ClaudeCode/${image.harnessVersion}/amd64`;
  const layerDir = `layers/ClaudeCode/${image.harnessVersion}/amd64`;
  const objects: Record<string, string> = {
    [`${imageDir}/${"b".repeat(64)}`]: "image",
    [`${imageDir}/${"7".repeat(64)}`]: "old image",
    [`${ociDir}/${"e".repeat(64)}`]: oci("a".repeat(64), "f".repeat(64)),
    [`${ociDir}/${"a".repeat(64)}`]: "config",
    [`${ociDir}/${"f".repeat(64)}`]: "blob",
    [`${ociDir}/${"0".repeat(64)}`]: oci("a".repeat(64), "6".repeat(64)),
    [`${ociDir}/${"6".repeat(64)}`]: "old blob",
    [`oci/base/amd64/${"5".repeat(64)}`]: oci("a".repeat(64), "9".repeat(64)),
    [`${layerDir}/${"1".repeat(64)}`]: "layer",
    [`${layerDir}/${"8".repeat(64)}`]: "old layer",
    [`${layerDir}/recipes/r1`]: JSON.stringify(layer),
    [`${layerDir}/recipes/r8`]: JSON.stringify({ ...layer, layerDigest: "8".repeat(64) }),
  };
  for (const [key, value] of Object.entries(objects)) await bucket.put(key, value);
  await bucket.put("releases/0.1.0.json", JSON.stringify(old));
  await sleep(5);

  const late = Date.now() + 2 * ARTIFACT_GRACE_MS;
  assert.deepEqual(await pruneReleases(bucket, "0.2.0", JSON.stringify(current), Date.now()), []);
  assert.deepEqual(await pruneReleases(bucket, "0.2.0", JSON.stringify(current), late), []);

  for (const version of ["0.3.0", "0.4.0", "0.5.0", "0.6.0"]) {
    await sleep(5);
    await pruneReleases(bucket, version, JSON.stringify({ ...current, releaseVersion: version }), Date.now());
  }
  await sleep(5);
  const dead = await pruneReleases(bucket, "0.7.0", JSON.stringify({ ...current, releaseVersion: "0.7.0" }), late);
  assert.deepEqual(dead.sort(), [
    `${imageDir}/${"7".repeat(64)}`,
    `${layerDir}/${"8".repeat(64)}`,
    `${layerDir}/recipes/r8`,
    `${ociDir}/${"0".repeat(64)}`,
    `${ociDir}/${"6".repeat(64)}`,
  ]);
  assert.equal(await bucket.get(`${imageDir}/${"7".repeat(64)}`), null);
  assert.notEqual(await bucket.get(`${ociDir}/${"f".repeat(64)}`), null);
});
