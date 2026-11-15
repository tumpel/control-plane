import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ChannelProtocol, ProblemSchema, ReleaseManifestSchema } from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { parseRelease, type ReleaseManifest } from "../src/releases.ts";

const R2_STUB_ORIGIN = "https://r2.example.test";
const SUPERVISOR_SHA = "a".repeat(64);
const IMAGE = "b".repeat(64);
const KERNEL = "c".repeat(64);
const MANIFEST = "d".repeat(64);

const RELEASE: ReleaseManifest = {
  releaseVersion: "0.2.0",
  commit: "e".repeat(40),
  channelProtocolVersion: ChannelProtocol.Version,
  supervisors: [{ architecture: "Amd64", sha256: SUPERVISOR_SHA, sizeBytes: 4096 }],
  images: [
    {
      harness: "ClaudeCode",
      harnessVersion: "2.0.0",
      architecture: "Amd64",
      imageDigest: IMAGE,
      kernelDigest: KERNEL,
      manifestDigest: MANIFEST,
      ociDigest: "e".repeat(64),
    },
  ],
};

type Bucket = { put(key: string, value: string): Promise<unknown> };

let server: TestHarness;
let origin: string;

before(async () => {
  server = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [
      { configPath: "./wrangler.jsonc", vars: { R2_STUB_ORIGIN, DASHBOARD_ORIGIN: "https://app.tumpel.test" } },
    ],
  });
  origin = (await server.listen()).url.origin;
});

after(async () => {
  await server?.close();
});

const get = (path: string) => server.fetch(`${origin}${path}`, { redirect: "manual" });

test("current.json parses against ReleaseManifest and refuses another channel protocol version or a repeated image", () => {
  assert.deepEqual(parseRelease(JSON.stringify(RELEASE)), RELEASE);
  assert.throws(() => parseRelease("{"), /current\.json in the release bucket is not JSON/);
  assert.throws(
    () => parseRelease(JSON.stringify({ ...RELEASE, commit: "main" })),
    /does not match ReleaseManifest in packages\/api\/release\.tsp: commit/,
  );
  assert.throws(() => parseRelease(JSON.stringify({ ...RELEASE, supervisors: [] })), /supervisors/);
  const [image] = RELEASE.images;
  assert.ok(image);
  assert.throws(
    () => parseRelease(JSON.stringify({ ...RELEASE, channelProtocolVersion: ChannelProtocol.Version + 1 })),
    new RegExp(
      `built for channel protocol version ${ChannelProtocol.Version + 1}, and this control plane speaks ${ChannelProtocol.Version}`,
    ),
  );
  assert.throws(
    () => parseRelease(JSON.stringify({ ...RELEASE, images: [image, image] })),
    /two images for ClaudeCode 2\.0\.0 Amd64/,
  );
});

test("with no current.json the release reads NoRelease, and once published it reads back and redirects to its supervisor", async () => {
  const missing = await get("/v1/releases/current");
  assert.equal(missing.status, 404);
  assert.equal(ProblemSchema.parse(await missing.json()).code, "NoRelease");
  assert.equal(ProblemSchema.parse(await (await get("/v1/releases/supervisor/Amd64")).json()).code, "NoRelease");

  await (await server.getWorker<{ RELEASES: Bucket }>().getEnv()).RELEASES.put("current.json", JSON.stringify(RELEASE));
  const current = await get("/v1/releases/current");
  assert.equal(current.status, 200);
  assert.deepEqual(ReleaseManifestSchema.parse(await current.json()), RELEASE);

  const redirect = await get("/v1/releases/supervisor/Amd64");
  assert.equal(redirect.status, 302);
  const location = new URL(redirect.headers.get("location") ?? "");
  assert.equal(location.origin, R2_STUB_ORIGIN);
  assert.equal(location.pathname, `/tumpel-releases/supervisor/amd64/${SUPERVISOR_SHA}`);
  assert.equal(location.searchParams.get("X-Tumpel-Method"), "GET");

  const arm = await get("/v1/releases/supervisor/Arm64");
  assert.equal(arm.status, 404);
  assert.match(
    ProblemSchema.parse(await arm.json()).detail,
    /release 0\.2\.0 carries supervisors for Amd64, not Arm64/,
  );
  assert.equal((await get("/v1/releases/supervisor/Sparc")).status, 400);
});
