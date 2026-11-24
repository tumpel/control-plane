import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { ProblemSchema } from "@tumpel/schemas";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { World } from "./harness/world.ts";
import { mcpPersona, startBox } from "./signal-fixtures.ts";

const idleForemenOnFullHost = async (t: TestContext, n: number) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 200_000, memoryAvailableMib: 200_000, diskBudgetMib: 2_000_000 },
  });
  const personaId = await mcpPersona(world);
  const foremen = [];
  for (let index = 0; index < n; index++) {
    const foreman = await startBox(world, host, personaId, "plan the work", "Warm");
    await host.finishes(foreman.offer);
    await world.subscribe(foreman.session, {
      prompt: "Continue the work",
      goal: "Land the work",
      events: ["StartRefused", "CapacityAvailable", "TurnCompleted"],
      crewTags: ["crew:x"],
    });
    foremen.push(foreman.session.sessionId);
  }
  const crew = await startBox(world, host, personaId, "box to stop", "Warm");
  await host.finishes(crew.offer);
  host.report({ memoryHeldMib: 200_000 });
  await world.settle();
  return { world, host, personaId, foremen, crew };
};

for (const [n, refusalBudget] of [
  [1, 24],
  [10, 222],
  [50, 1102],
] as const) {
  test(`a matched refusal offers a delivery to each of ${n} idle Foremen`, async (t) => {
    const { world, host, personaId, foremen, crew } = await idleForemenOnFullHost(t, n);
    const sql = world.tenantSql();
    const count = (): number => Number(sql.exec("SELECT COUNT(*) AS count FROM events").one().count);
    const eventsBefore = count();
    const before = world.tenantRowsWritten();
    const refused = await world.fetch(
      world.owner,
      "POST",
      "/v1/sessions",
      JSON.stringify({
        personaId,
        model: "opus",
        prompt: "start crew work",
        repository: "https://github.com/acme/app",
        tags: ["crew:x"],
      }),
    );
    assert.equal(refused.status, 409, await refused.clone().text());
    assert.equal(ProblemSchema.parse(await refused.json()).code, "PoolExhausted");
    assert.equal(world.tenantRowsWritten() - before, refusalBudget);
    assert.equal(count(), eventsBefore + 1);
    assert.equal(sql.exec("SELECT COUNT(*) AS count FROM subscription_room_waits").one().count, n);
    const offers = Array.from({ length: n }, () => host.takeOffer());
    assert.deepEqual(new Set(offers.map(({ sessionId }) => sessionId)), new Set(foremen));

    if (n === 50) {
      for (const offer of offers) {
        await host.claims(offer);
        await host.finishes(offer);
      }
      const stopEvents = count();
      const stopBefore = world.tenantRowsWritten();
      await host.dropsIdleBox(crew.offer);
      assert.equal(world.tenantRowsWritten() - stopBefore, 1059);
      assert.equal(count(), stopEvents + 2);
      assert.equal(
        sql
          .exec("SELECT COUNT(*) AS count FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
          .one().count,
        1,
      );
      const signaled = Array.from({ length: 50 }, () => host.takeOffer());
      assert.deepEqual(new Set(signaled.map(({ sessionId }) => sessionId)), new Set(foremen));
      assert.ok(signaled.every(({ prompt }) => prompt.includes('"event":"CapacityAvailable"')));
    }
  });
}
