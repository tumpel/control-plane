import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { PRINCIPAL_ID, TENANT_ID, World } from "./harness/world.ts";
import { mcpPersona, startBox } from "./signal-fixtures.ts";

for (const [n, refusalBudget] of [
  [1, 23],
  [10, 203],
  [50, 1003],
] as const) {
  test(`FN with ${n} idle Foremen meters enqueueing and compares offers to crew wakes`, async (t) => {
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
    const room = {
      tenantId: TENANT_ID,
      personaId,
      model: "opus",
      refusal: { code: "PoolExhausted", detail: "The host has no room." },
      now: Date.now(),
    };
    for (const { session, offer } of foremen) {
      assert.deepEqual(
        await world.call("recordStartRefusal", {
          ...room,
          caller: { kind: "Turn", sessionId: session.sessionId, turnId: offer.turnId },
          requestedTags: [],
        }),
        { kind: "Recorded" },
      );
    }
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
    const input = {
      ...room,
      now: Date.now(),
      caller: { kind: "Person" as const, principalId: PRINCIPAL_ID },
      requestedTags: ["crew:x"],
    };
    const rows = counts();
    const before = world.tenantRowsWritten();
    assert.deepEqual(
      world.tenantOperations().recordStartRefusal({
        ...input,
        refusal: { code: "ModelUnsupported", detail: "The model is unavailable." },
      }),
      { kind: "Recorded" },
    );
    assert.equal(world.tenantRowsWritten() - before, 3 + 8 * n);
    assert.deepEqual(counts(), { events: rows.events + 1, deliveries: rows.deliveries + n });
    assert.equal(host.holds("TurnOffer"), false);

    await world.call("listEvents", {
      tenantId: TENANT_ID,
      afterEventId: null,
      events: [],
      sessionId: null,
      triggerId: null,
    });
    for (let index = 0; index < n; index++) {
      const offer = host.takeOffer();
      await host.claims(offer);
      await host.finishes(offer);
    }
    const refusalBefore = world.tenantRowsWritten();
    assert.deepEqual(await world.call("recordStartRefusal", input), { kind: "Recorded" });
    const refusalWrites = world.tenantRowsWritten() - refusalBefore;
    assert.equal(refusalWrites, refusalBudget);
    assert.equal(refusalWrites - 3, crewWakeWrites);
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
      assert.equal(signalWrites, 1003);
      assert.equal(signalWrites - 3, crewWakeWrites);
      const signaled = Array.from({ length: 50 }, () => host.takeOffer());
      assert.ok(signaled.every(({ prompt }) => prompt.includes('"event":"CapacityAvailable"')));
    }
  });
}
