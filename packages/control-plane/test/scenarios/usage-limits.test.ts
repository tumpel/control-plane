import assert from "node:assert/strict";
import { test } from "node:test";
import { ProblemSchema, SecretSetSchema } from "@tumpel/schemas";
import { LIMITS, type Member, World } from "./harness/world.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const FREE_TENANTS_PER_ACCOUNT = 40;
const FREE_LIMITS = [
  { measure: "Requests", window: "Day", limit: (Math.min(100_000, 100_000 / 2) * 0.8) / FREE_TENANTS_PER_ACCOUNT },
  {
    measure: "Requests",
    window: "Minute",
    limit: (Math.min(100_000, 100_000 / 2) * 0.8) / FREE_TENANTS_PER_ACCOUNT / 100,
  },
  { measure: "RowsWritten", window: "Day", limit: (100_000 * 0.8) / FREE_TENANTS_PER_ACCOUNT },
  { measure: "RowsRead", window: "Day", limit: (5_000_000 * 0.8) / FREE_TENANTS_PER_ACCOUNT },
];
const FREE_REQUESTS_PER_MINUTE = 10;
const FREE_PACE = FREE_REQUESTS_PER_MINUTE - 1;
const freePace = (sent: number): number => (sent > 0 && sent % FREE_PACE === 0 ? MINUTE : 0);

class Churn {
  private held: string | null = null;
  private made = 0;
  private readonly world: World;
  private readonly member: Member;

  constructor(world: World, member: Member) {
    this.world = world;
    this.member = member;
  }

  async write(): Promise<Response> {
    if (this.held !== null) {
      const response = await this.world.fetch(this.member, "DELETE", `/v1/secret-sets/${this.held}`);
      if (response.ok) this.held = null;
      return response;
    }
    this.made += 1;
    const body = JSON.stringify({ name: `churn-${this.made}`, secrets: [] });
    const response = await this.world.fetch(this.member, "POST", "/v1/secret-sets", body);
    if (response.ok) this.held = SecretSetSchema.parse(await response.clone().json()).secretSetId;
    return response;
  }
}

const untilRefused = async (
  world: World,
  write: () => Promise<Response>,
  most: number,
  pause: (sent: number) => number,
): Promise<{ served: number; refused: Response }> => {
  for (let sent = 0; sent < most; sent += 1) {
    await world.passes(pause(sent));
    const response = await write();
    if (response.status === 429) return { served: sent, refused: response };
    assert.ok(response.ok, `write ${sent} answered ${response.status}`);
  }
  throw new Error(`${most} writes were all served; the limit never refused one`);
};

const toNextHour = (): number => HOUR - (Date.now() % HOUR);

test("a tenant past its hourly rows-written budget is refused, writes no more rows, and is served again the next hour", async (t) => {
  const world = await World.open({
    limits: { ...LIMITS, configured: [{ measure: "RowsWritten", window: "Hour", limit: 500 }] },
  });
  t.after(() => world.close());
  const churn = new Churn(world, world.owner);

  const { served, refused } = await untilRefused(
    world,
    () => churn.write(),
    1000,
    (sent) => (sent > 0 && sent % 100 === 0 ? MINUTE : 0),
  );

  assert.ok(served > 0, "some writes fit the budget before it was spent");
  const refusal = ProblemSchema.parse(await refused.json());
  assert.equal(refusal.code, "UsageLimitReached");
  assert.match(refusal.detail, /limit of 500 RowsWritten per hour/);
  const written = world.rowsWritten(world.owner);
  assert.equal((await churn.write()).status, 429);
  assert.equal(world.rowsWritten(world.owner), written);
  assert.deepEqual(
    world.events(world.owner).filter((event) => event.startsWith("Usage")),
    ["UsageNearLimit", "UsageLimitReached"],
  );

  await world.passes(toNextHour());
  assert.ok((await churn.write()).ok);
});

test("a free-tier tenant past its daily allowance is refused and nothing past it is written", async (t) => {
  const world = await World.open({ limits: { ...LIMITS, freeTenantsPerAccount: FREE_TENANTS_PER_ACCOUNT } });
  t.after(() => world.close());
  const free = await world.tenant("free", "Free");
  const churn = new Churn(world, free);

  const { served, refused } = await untilRefused(world, () => churn.write(), 1100, freePace);

  assert.ok(served > 0, "some writes fit the allowance before it was spent");
  const refusal = ProblemSchema.parse(await refused.json());
  assert.equal(refusal.code, "UsageLimitReached");
  assert.match(refusal.detail, /on the Free tier spent its limit of \d+ \w+ per day/);
  const written = world.rowsWritten(free);
  await world.passes(MINUTE);
  assert.equal((await churn.write()).status, 429);
  assert.equal((await churn.write()).status, 429);
  assert.equal(world.rowsWritten(free), written);
});

test("a free-tier tenant restarted mid-day keeps its day's counts", async (t) => {
  const world = await World.open({ limits: { ...LIMITS, freeTenantsPerAccount: FREE_TENANTS_PER_ACCOUNT } });
  t.after(() => world.close());
  const free = await world.tenant("free", "Free");
  const churn = new Churn(world, free);
  for (let sent = 0; sent < 20; sent += 1) {
    await world.passes(freePace(sent));
    assert.ok((await churn.write()).ok);
  }
  await world.passes(MINUTE);
  const day = (usage: Awaited<ReturnType<World["usage"]>>) =>
    usage.counters.filter((counter) => counter.window === "Day").map(({ measure, used }) => ({ measure, used }));
  const before = day(await world.usage(free));
  assert.ok(before.some(({ measure, used }) => measure === "Requests" && used >= 20));

  await world.restartTenant(free.tenantId);

  const after = await world.usage(free);
  assert.equal(after.tier, "Free");
  assert.deepEqual(
    day(after).map(({ measure, used }) => ({
      measure,
      kept: used >= (before.find((held) => held.measure === measure)?.used ?? 0),
    })),
    before.map(({ measure }) => ({ measure, kept: true })),
  );
  assert.deepEqual(
    day(after).find(({ measure }) => measure === "Requests"),
    before.find(({ measure }) => measure === "Requests"),
  );
});

test("a free and a configured tenant on one deployment get different limits, the free one is refused at its allowance, and both are warned near their limits", async (t) => {
  const world = await World.open({
    limits: {
      ...LIMITS,
      freeTenantsPerAccount: FREE_TENANTS_PER_ACCOUNT,
      configured: [{ measure: "RowsWritten", window: "Hour", limit: 1000 }],
    },
  });
  t.after(() => world.close());
  const free = await world.tenant("free", "Free");
  const configured = world.owner;

  const freeUsage = await world.usage(free);
  const configuredUsage = await world.usage(configured);
  assert.equal(freeUsage.tier, "Free");
  assert.deepEqual(
    freeUsage.counters.map(({ measure, window, limit }) => ({ measure, window, limit })),
    FREE_LIMITS,
  );
  assert.equal(FREE_LIMITS[1]?.limit, FREE_REQUESTS_PER_MINUTE);
  assert.equal(configuredUsage.tier, "Configured");
  assert.deepEqual(
    configuredUsage.counters.map(({ measure, window, limit }) => ({ measure, window, limit })),
    [{ measure: "RowsWritten", window: "Hour", limit: 1000 }],
  );

  const freeChurn = new Churn(world, free);
  await untilRefused(world, () => freeChurn.write(), 1100, freePace);
  assert.ok(world.events(free).includes("UsageNearLimit"));

  await world.passes(toNextHour());
  const configuredChurn = new Churn(world, configured);
  for (let sent = 0; !world.events(configured).includes("UsageNearLimit"); sent += 1) {
    assert.ok(sent < 1000, "the configured tenant was never warned near its limit");
    if (sent > 0 && sent % 100 === 0) await world.passes(MINUTE);
    assert.ok((await configuredChurn.write()).ok, "the configured tenant is served below its limit");
  }
});
