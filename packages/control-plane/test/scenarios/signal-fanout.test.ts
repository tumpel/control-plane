import assert from "node:assert/strict";
import { test } from "node:test";
import { ProblemSchema } from "@tumpel/schemas";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { World } from "./harness/world.ts";
import { mcpPersona, startBox } from "./signal-fixtures.ts";

for (const [n, refusalBudget] of [
  [1, 24],
  [10, 222],
  [50, 1102],
] as const) {
  test(`FN with ${n} idle Foremen measures refusal and capacity deliveries against crew wakes`, async (t) => {
    const world = await World.open();
    t.after(() => world.close());
    const host = await world.online(world.owner, "host-1", {
      usage: { ...DEFAULT_USAGE, memoryBudgetMib: 200_000, memoryAvailableMib: 200_000, diskBudgetMib: 2_000_000 },
    });
    const personaId = await mcpPersona(world);
    const foremen = [];
    for (let index = 0; index < n; index++) {
      const foreman = await startBox(world, host, personaId, `plan the work ${index}`, "Warm");
      await host.finishes(foreman.offer);
      foremen.push(foreman);
    }
    const ordinary = await startBox(world, host, personaId, "ordinary crew work", "Warm", ["crew:x"]);
    const unmatched = await startBox(world, host, personaId, "unmatched work", "Warm");
    const extra = n === 50 ? await startBox(world, host, personaId, "box to stop", "Warm") : null;
    if (extra !== null) await host.finishes(extra.offer);
    const spare = n === 50 ? await startBox(world, host, personaId, "box for stop baseline", "Warm") : null;
    if (spare !== null) await host.finishes(spare.offer);
    const stopBaselineBefore = world.tenantRowsWritten();
    if (spare !== null) await host.dropsIdleBox(spare.offer);
    const stopBaseline = world.tenantRowsWritten() - stopBaselineBefore;
    for (const { session } of foremen) {
      await world.subscribe(session, {
        prompt: "Continue the work",
        goal: "Land the work",
        events: ["StartRefused", "CapacityAvailable", "TurnCompleted"],
        crewTags: ["crew:x"],
      });
    }
    host.report({ memoryHeldMib: 200_000 });
    await world.settle();

    const unmatchedBefore = world.tenantRowsWritten();
    await host.finishes(unmatched.offer);
    const completionWrites = world.tenantRowsWritten() - unmatchedBefore;
    assert.equal(host.holds("TurnOffer"), false);
    const crewBefore = world.tenantRowsWritten();
    await host.finishes(ordinary.offer);
    const crewFailureResetWrites = n;
    const crewWakeWrites = world.tenantRowsWritten() - crewBefore - completionWrites - crewFailureResetWrites;
    assert.equal(crewWakeWrites / n, 20, "ordinary crew wake writes per idle Foreman");
    const crewOffers = Array.from({ length: n }, () => host.takeOffer());
    assert.deepEqual(
      new Set(crewOffers.map(({ sessionId }) => sessionId)),
      new Set(foremen.map(({ session }) => session.sessionId)),
    );
    for (const offer of crewOffers) {
      assert.match(offer.prompt, /"event":"TurnCompleted"/);
      await host.claims(offer);
      await host.finishes(offer);
    }
    await world.passes(60_001);

    const sql = world.tenantSql();
    const counts = () => ({
      events: Number(sql.exec("SELECT COUNT(*) AS count FROM events").one().count),
      deliveries: Number(sql.exec("SELECT COUNT(*) AS count FROM subscription_turns").one().count),
    });
    const rows = counts();
    const refusalBefore = world.tenantRowsWritten();
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
    assert.deepEqual(counts(), { events: rows.events + 1, deliveries: rows.deliveries + n });
    assert.equal(sql.exec("SELECT COUNT(*) AS count FROM subscription_room_waits").one().count, n);
    const refusalWrites = world.tenantRowsWritten() - refusalBefore;
    assert.equal(refusalWrites, refusalBudget);
    assert.equal(refusalWrites - 2 - 2 * n, crewWakeWrites);
    const offers = Array.from({ length: n }, () => host.takeOffer());
    assert.deepEqual(
      new Set(offers.map(({ sessionId }) => sessionId)),
      new Set(foremen.map(({ session }) => session.sessionId)),
    );

    if (extra !== null) {
      for (const offer of offers) {
        await host.claims(offer);
        await host.finishes(offer);
      }
      assert.equal(counts().deliveries, 0);
      const stopRows = counts();
      const stopBefore = world.tenantRowsWritten();
      await host.dropsIdleBox(extra.offer);
      assert.deepEqual(counts(), { events: stopRows.events + 2, deliveries: 50 });
      assert.equal(
        sql
          .exec("SELECT COUNT(*) AS count FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
          .one().count,
        1,
      );
      const signalWrites = world.tenantRowsWritten() - stopBefore - stopBaseline;
      assert.equal(signalWrites, 1052);
      assert.equal(signalWrites - 2 - n, crewWakeWrites);
      const signaled = Array.from({ length: 50 }, () => host.takeOffer());
      assert.ok(signaled.every(({ prompt }) => prompt.includes('"event":"CapacityAvailable"')));
    }
  });
}
