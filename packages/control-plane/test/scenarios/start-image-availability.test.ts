import assert from "node:assert/strict";
import { test } from "node:test";
import { PersonaSchema, ProblemSchema } from "@tumpel/schemas";
import { CLAUDE_CODE_VERSION } from "../../src/harness-catalog.ts";
import { CURRENT_RELEASE_KEY, RELEASE_CACHE_MS } from "../../src/releases.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "../release-fixture.ts";
import { World } from "./harness/world.ts";

test("a pinned start distinguishes a missing image from an image for another architecture", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  await world.hostOnline("host-1");
  const personas = await world.fetch(world.owner, "GET", "/v1/personas");
  assert.equal(personas.status, 200);
  const [persona] = PersonaSchema.array().parse(await personas.json());
  assert.ok(persona);
  await world.call("pin", {
    pin: { harness: "ClaudeCode", harnessVersion: CLAUDE_CODE_VERSION },
    now: Date.now(),
  });
  const start = JSON.stringify({
    personaId: persona.personaId,
    repository: "https://github.com/acme/app",
    model: "opus",
    prompt: "start work",
  });

  const release = CLAUDE_CODE_AMD64_RELEASE;
  await world.releases.put(
    CURRENT_RELEASE_KEY,
    JSON.stringify({
      ...release,
      images: release.images.map((image) => ({ ...image, harnessVersion: "2.1.1" })),
      harnessLayers: release.harnessLayers.map((image) => ({ ...image, harnessVersion: "2.1.1" })),
    }),
  );
  await world.passes(RELEASE_CACHE_MS + 1);
  const missing = await world.fetch(world.owner, "POST", "/v1/sessions", start);
  assert.equal(missing.status, 422);
  const problem = ProblemSchema.parse(await missing.json());
  assert.equal(problem.code, "ImageNotReleased");
  assert.equal(problem.title, "No guest image for this harness version");
  assert.equal(problem.detail, `the published release carries no ClaudeCode ${CLAUDE_CODE_VERSION} guest image`);

  await world.releases.put(
    CURRENT_RELEASE_KEY,
    JSON.stringify({
      ...release,
      images: release.images.map((image) => ({ ...image, architecture: "Arm64" })),
      harnessLayers: release.harnessLayers.map((image) => ({ ...image, architecture: "Arm64" })),
      bases: release.bases.map((base) => ({ ...base, architecture: "Arm64" })),
    }),
  );
  await world.passes(RELEASE_CACHE_MS + 1);
  const otherArchitecture = await world.fetch(world.owner, "POST", "/v1/sessions", start);
  assert.equal(otherArchitecture.status, 409);
  assert.equal(ProblemSchema.parse(await otherArchitecture.json()).code, "NoHostAvailable");
});
