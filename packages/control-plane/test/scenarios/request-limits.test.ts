import assert from "node:assert/strict";
import { test } from "node:test";
import { ProblemSchema } from "@tumpel/schemas";
import { LIMITS, type Member, World } from "./harness/world.ts";

const MAX_BODY_BYTES = 4_000_000;

const createSecretSet = (world: World, member: Member, name: string): Promise<Response> =>
  world.fetch(member, "POST", "/v1/secret-sets", JSON.stringify({ name, secrets: [] }));

test("a body over the 4 MB bound is refused with 413 before any row is written", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const written = world.rowsWritten(world.owner);

  const oversize = JSON.stringify({ name: "huge", secrets: [], padding: "x".repeat(MAX_BODY_BYTES) });
  const response = await world.fetch(world.owner, "POST", "/v1/secret-sets", oversize);

  assert.equal(response.status, 413);
  const refusal = ProblemSchema.parse(await response.json());
  assert.equal(refusal.code, "BodyTooLarge");
  assert.match(refusal.detail, /4000000/);
  assert.equal(world.rowsWritten(world.owner), written);
  assert.equal((await createSecretSet(world, world.owner, "fits")).status, 200);
});

test("a write burst past the per-minute write rate gets 429 and writes nothing", async (t) => {
  const world = await World.open({
    limits: { ...LIMITS, writesPerMinute: 5, ceiling: { ...LIMITS.ceiling, writesPerMinute: 5 } },
  });
  t.after(() => world.close());

  for (const name of ["one", "two", "three", "four", "five"]) {
    assert.equal((await createSecretSet(world, world.owner, name)).status, 200);
  }
  const written = world.rowsWritten(world.owner);
  const response = await createSecretSet(world, world.owner, "six");

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  const refusal = ProblemSchema.parse(await response.json());
  assert.equal(refusal.code, "RateLimited");
  assert.match(refusal.detail, /more than 5 writing requests in a minute/);
  assert.equal(world.rowsWritten(world.owner), written);
});

test("one tenant bursting gets 429 while a second tenant's requests still succeed", async (t) => {
  const world = await World.open({
    limits: { ...LIMITS, writesPerMinute: 3, ceiling: { ...LIMITS.ceiling, writesPerMinute: 3 } },
  });
  t.after(() => world.close());
  const quiet = await world.tenant("quiet", "Configured");

  for (const name of ["one", "two", "three"]) {
    assert.equal((await createSecretSet(world, world.owner, name)).status, 200);
  }
  assert.equal((await createSecretSet(world, world.owner, "four")).status, 429);

  assert.equal((await createSecretSet(world, quiet, "one")).status, 200);
  assert.equal((await world.fetch(quiet, "GET", "/v1/secret-sets")).status, 200);
});
