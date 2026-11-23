import assert from "node:assert/strict";
import { test } from "node:test";
import { ProblemSchema, TenantLimitsSchema } from "@tumpel/schemas";
import type { TenantLimitsProfile } from "../../src/limits.ts";
import { LIMITS, type Member, World } from "./harness/world.ts";

const RAISED_FRAMES_PER_MINUTE = 1200;

const PROFILE: TenantLimitsProfile = {
  writesPerMinute: LIMITS.writesPerMinute,
  hostFramesPerMinute: LIMITS.hostFramesPerMinute,
  usage: [{ measure: "RowsWritten", window: "Hour", limit: 1_000_000 }],
};

const setLimits = (world: World, member: Member, body: unknown): Promise<Response> =>
  world.fetch(member, "PUT", "/v1/limits", JSON.stringify(body));

const createSecretSet = (world: World, member: Member, name: string): Promise<Response> =>
  world.fetch(member, "POST", "/v1/secret-sets", JSON.stringify({ name, secrets: [] }));

test("a tenant past the write rate of its own profile is refused by its object, and keeps the profile across a restart", async (t) => {
  const world = await World.open();
  t.after(() => world.close());

  const before = TenantLimitsSchema.parse(await (await world.fetch(world.owner, "GET", "/v1/limits")).json());
  assert.equal(before.source, "Configured");
  const set = await setLimits(world, world.owner, { ...PROFILE, writesPerMinute: 2 });
  assert.equal(set.status, 200);
  assert.equal(TenantLimitsSchema.parse(await set.json()).source, "Custom");

  await world.passes(60_000);
  assert.equal((await createSecretSet(world, world.owner, "one")).status, 200);
  assert.equal((await createSecretSet(world, world.owner, "two")).status, 200);
  const refused = await createSecretSet(world, world.owner, "three");
  assert.equal(refused.status, 429);
  assert.match(ProblemSchema.parse(await refused.json()).detail, /more than 2 writing requests in a minute/);

  await world.restartTenant();
  await world.passes(60_000);
  const kept = TenantLimitsSchema.parse(await (await world.fetch(world.owner, "GET", "/v1/limits")).json());
  assert.equal(kept.source, "Custom");
  assert.equal(kept.profile.writesPerMinute, 2);
});

test("limits past the ceiling are refused, a Free tenant cannot raise itself above the Free preset, and a reset keeps its tier", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const free = await world.tenant("free", "Free");

  const past = await setLimits(world, world.owner, { ...PROFILE, hostFramesPerMinute: RAISED_FRAMES_PER_MINUTE });
  assert.equal(past.status, 400);
  assert.match(ProblemSchema.parse(await past.json()).detail, /hostFramesPerMinute 1200 is over 600/);

  const above = await setLimits(world, free, PROFILE);
  assert.equal(above.status, 403);
  assert.equal(ProblemSchema.parse(await above.json()).code, "AboveFreeTier");

  const preset = TenantLimitsSchema.parse(await (await world.fetch(free, "GET", "/v1/limits")).json());
  assert.equal(preset.source, "Free");
  const lowered = await setLimits(world, free, { ...preset.profile, hostFramesPerMinute: 100 });
  assert.equal(lowered.status, 200);
  assert.equal(TenantLimitsSchema.parse(await lowered.json()).source, "Custom");

  const reset = await setLimits(world, free, { reset: true });
  assert.equal(reset.status, 200);
  assert.deepEqual(TenantLimitsSchema.parse(await reset.json()), preset);
  assert.equal((await world.usage(free)).tier, "Free");
});
