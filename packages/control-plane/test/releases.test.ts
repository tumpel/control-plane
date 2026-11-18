import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ChannelProtocol, ProblemSchema } from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { bootArchitectures, bootFor, parseRelease, type ReleaseManifest } from "../src/releases.ts";

const R2_STUB_ORIGIN = "https://r2.example.test";
const SUPERVISOR_SHA = "a".repeat(64);
const CLI_SHA = "f".repeat(64);
const IMAGE = "b".repeat(64);
const KERNEL = "c".repeat(64);
const MANIFEST = "d".repeat(64);

const RELEASE: ReleaseManifest = {
  releaseVersion: "0.2.0",
  commit: "e".repeat(40),
  channelProtocolVersion: ChannelProtocol.Version,
  supervisors: [
    {
      architecture: "Amd64",
      sha256: SUPERVISOR_SHA,
      sizeBytes: 4096,
      supervisorVersion: "0.1.0",
      guestProtocolVersion: 11,
    },
  ],
  clis: [{ architecture: "Amd64", sha256: CLI_SHA, sizeBytes: 2048, cliVersion: "0.2.1" }],
  images: [
    {
      harness: "ClaudeCode",
      harnessVersion: "2.0.0",
      architecture: "Amd64",
      imageDigest: IMAGE,
      kernelDigest: KERNEL,
      manifestDigest: MANIFEST,
      ociDigest: "e".repeat(64),
      rootfsDigest: "9".repeat(64),
    },
  ],
  harnessLayers: [
    {
      harness: "ClaudeCode",
      harnessVersion: "2.0.0",
      architecture: "Amd64",
      layerDigest: "1".repeat(64),
      manifestDigest: "2".repeat(64),
      sizeBytes: 65536,
    },
  ],
  bases: [
    {
      architecture: "Amd64",
      imageDigest: "3".repeat(64),
      kernelDigest: KERNEL,
      manifestDigest: "4".repeat(64),
      ociDigest: "5".repeat(64),
      rootfsDigest: "6".repeat(64),
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

const refused = (text: string): string => {
  const parsed = parseRelease(text);
  assert.equal(parsed.ok, false);
  return parsed.ok ? "" : parsed.detail;
};

test("current.json parses against ReleaseManifest, keeps its channel protocol version and names a repeated image", () => {
  assert.deepEqual(parseRelease(JSON.stringify(RELEASE)), { ok: true, manifest: RELEASE });
  const older = { ...RELEASE, channelProtocolVersion: ChannelProtocol.Version - 1 };
  assert.deepEqual(parseRelease(JSON.stringify(older)), { ok: true, manifest: older });
  assert.match(refused("{"), /current\.json in the release bucket is not JSON/);
  assert.match(
    refused(JSON.stringify({ ...RELEASE, commit: "main" })),
    /does not match ReleaseManifest in typespec\/lib\/release\.tsp: commit/,
  );
  assert.match(refused(JSON.stringify({ ...RELEASE, supervisors: [] })), /supervisors/);
  assert.match(refused(JSON.stringify({ ...RELEASE, clis: [] })), /clis/);
  const { clis: _clis, ...withoutClis } = RELEASE;
  assert.match(refused(JSON.stringify(withoutClis)), /clis/);
  const [cli] = RELEASE.clis;
  assert.ok(cli);
  assert.match(refused(JSON.stringify({ ...RELEASE, clis: [cli, cli] })), /two CLIs for Amd64/);
  const [image] = RELEASE.images;
  assert.ok(image);
  assert.match(
    refused(JSON.stringify({ ...RELEASE, images: [image, image] })),
    /two images for ClaudeCode 2\.0\.0 Amd64/,
  );
});

test("a turn boots layered where the release carries a base and the harness layer, else from the full image", () => {
  const published = { kind: "Published" as const, manifest: RELEASE };
  const [base] = RELEASE.bases;
  const [layer] = RELEASE.harnessLayers;
  const [image] = RELEASE.images;
  assert.ok(base && layer && image);
  assert.deepEqual(bootFor(published, "ClaudeCode", "2.0.0", "Amd64"), { kind: "Layered", base, layer });
  const withoutLayer = {
    kind: "Published" as const,
    manifest: { ...RELEASE, harnessLayers: [{ ...layer, harness: "Shell" as const }] },
  };
  assert.deepEqual(bootFor(withoutLayer, "ClaudeCode", "2.0.0", "Amd64"), { kind: "Full", image });
  const armBase = {
    kind: "Published" as const,
    manifest: { ...RELEASE, bases: [{ ...base, architecture: "Arm64" as const }] },
  };
  assert.deepEqual(bootFor(armBase, "ClaudeCode", "2.0.0", "Amd64"), { kind: "Full", image });
  assert.equal(bootFor(published, "ClaudeCode", "1.0.0", "Amd64"), undefined);
  assert.deepEqual(bootArchitectures(published, "ClaudeCode", "2.0.0"), ["Amd64"]);
  const layerOnly = { kind: "Published" as const, manifest: { ...RELEASE, images: [] } };
  assert.deepEqual(bootArchitectures(layerOnly, "ClaudeCode", "2.0.0"), ["Amd64"]);
  assert.deepEqual(bootArchitectures(layerOnly, "OpenCode", "1.0.0"), []);
});

test("with no current.json the release reads NoRelease, a malformed one ReleaseUnreadable, and a published one of an older protocol reads back with the fields this control plane does not know and redirects to its supervisor", async () => {
  const missing = await get("/v1/releases/current");
  assert.equal(missing.status, 404);
  assert.equal(ProblemSchema.parse(await missing.json()).code, "NoRelease");
  assert.equal(ProblemSchema.parse(await (await get("/v1/releases/supervisor/Amd64")).json()).code, "NoRelease");

  const releases = (await server.getWorker<{ RELEASES: Bucket }>().getEnv()).RELEASES;
  await releases.put("current.json", JSON.stringify({ ...RELEASE, commit: "main" }));
  for (const path of ["/v1/releases/current", "/v1/releases/supervisor/Amd64", "/v1/releases/cli/Amd64"]) {
    const unreadable = await get(path);
    assert.equal(unreadable.status, 503);
    const body = ProblemSchema.parse(await unreadable.json());
    assert.equal(body.code, "ReleaseUnreadable");
    assert.match(body.detail, /the published release is unreadable: current\.json .* commit/);
  }

  const older = {
    ...RELEASE,
    channelProtocolVersion: ChannelProtocol.Version - 1,
    supervisors: RELEASE.supervisors.map((supervisor) => ({ ...supervisor, unknownToThisControlPlane: 7 })),
  };
  await releases.put("current.json", JSON.stringify(older));
  const current = await get("/v1/releases/current");
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), older);

  const redirect = await get("/v1/releases/supervisor/Amd64");
  assert.equal(redirect.status, 302);
  assert.equal(
    redirect.headers.get("location"),
    "https://github.com/tumpel/supervisor/releases/download/v0.1.0/tumpel-supervisor-x86_64-linux",
  );

  const arm = await get("/v1/releases/supervisor/Arm64");
  assert.equal(arm.status, 404);
  assert.match(
    ProblemSchema.parse(await arm.json()).detail,
    /release 0\.2\.0 carries supervisors for Amd64, not Arm64/,
  );
  assert.equal((await get("/v1/releases/supervisor/Sparc")).status, 400);
});

test("the CLI download redirects to the GitHub release asset of the current release's CLI for the architecture", async () => {
  await (await server.getWorker<{ RELEASES: Bucket }>().getEnv()).RELEASES.put("current.json", JSON.stringify(RELEASE));
  const redirect = await get("/v1/releases/cli/Amd64");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("cache-control"), "no-store");
  assert.equal(
    redirect.headers.get("location"),
    "https://github.com/tumpel/cli/releases/download/v0.2.1/tumpel-x86_64-linux",
  );

  const arm = await get("/v1/releases/cli/Arm64");
  assert.equal(arm.status, 404);
  assert.match(ProblemSchema.parse(await arm.json()).detail, /release 0\.2\.0 carries CLIs for Amd64, not Arm64/);
  assert.equal((await get("/v1/releases/cli/Sparc")).status, 400);
});
