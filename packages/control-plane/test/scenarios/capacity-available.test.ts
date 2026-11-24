import assert from "node:assert/strict";
import { test } from "node:test";
import { ProblemSchema, ServeConnectorTokenResultSchema } from "@tumpel/schemas";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { TENANT_ID, World } from "./harness/world.ts";

test("a full host wakes its foreman once on refusal and once when a box stops, then the crew starts", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    boxCapacity: 2,
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 4096, memoryAvailableMib: 4096 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  assert.equal(
    (await world.fetch(world.owner, "PATCH", `/v1/personas/${foreman.personaId}`, JSON.stringify({ tumpelMcp: true })))
      .status,
    200,
  );
  const subscription = await world.subscribe(foreman, {
    prompt: "handle starts",
    goal: "finish",
    events: ["StartRefused", "CapacityAvailable"],
    crewTags: ["crew:work"],
  });
  const turn = host.takeOffer();
  await host.claims(turn);
  const filler = await world.startSession({ prompt: "fill the host", tags: [], boxRetention: "Warm" });
  const busy = host.takeOffer();
  assert.equal(busy.sessionId, filler.sessionId);
  await host.claims(busy);
  const { served } = ServeConnectorTokenResultSchema.parse(
    await world.call("serveConnectorToken", { turnId: turn.turnId, connectorId: "tumpel", now: Date.now() }),
  );
  assert.equal(served.kind, "Served");
  const member = { tenantId: TENANT_ID, token: served.token.accessToken };
  const written = world.tenantRowsWritten();
  const refused = await world.fetch(
    member,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "crew work",
    }),
  );
  assert.equal(refused.status, 409);
  assert.equal(ProblemSchema.parse(await refused.json()).code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - written, 2);
  await host.finishes(turn);
  const refusalDelivery = host.takeOffer();
  assert.equal((refusalDelivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
  await host.claims(refusalDelivery);
  await host.finishes(refusalDelivery);
  await host.finishes(busy);
  const beforeCapacity = world
    .tenantSql()
    .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
    .toArray().length;
  const capacityWritten = world.tenantRowsWritten();
  await host.dropsIdleBox(busy);
  assert.equal(world.tenantRowsWritten() - capacityWritten, 29);
  assert.equal(
    world
      .tenantSql()
      .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
      .toArray().length - beforeCapacity,
    1,
  );
  const capacityDelivery = host.takeOffer();
  assert.equal(capacityDelivery.sessionId, foreman.sessionId);
  assert.equal((capacityDelivery.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
  await host.claims(capacityDelivery);
  const { served: retryToken } = ServeConnectorTokenResultSchema.parse(
    await world.call("serveConnectorToken", {
      turnId: capacityDelivery.turnId,
      connectorId: "tumpel",
      now: Date.now(),
    }),
  );
  assert.equal(retryToken.kind, "Served");
  const retry = await world.fetch(
    { tenantId: TENANT_ID, token: retryToken.token.accessToken },
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "crew retry",
    }),
  );
  assert.equal(retry.status, 200);
  const crew = host.takeOffer();
  await host.claims(crew);
  await host.finishes(capacityDelivery);
  await host.finishes(crew);
  await host.dropsIdleBox(crew);
  assert.equal(host.holds("TurnOffer"), false);
  assert.equal((await world.subscription(subscription.subscriptionId)).state, "Active");
  const again = await world.startSession({ prompt: "fill after success", tags: [], boxRetention: "Warm" });
  const againBusy = host.takeOffer();
  assert.equal(againBusy.sessionId, again.sessionId);
  await host.claims(againBusy);
  const refusedAgain = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "more crew work",
      tags: ["crew:work"],
    }),
  );
  assert.equal(refusedAgain.status, 409);
  const refusedAgainDelivery = host.takeOffer();
  await host.claims(refusedAgainDelivery);
  await host.finishes(refusedAgainDelivery);
  assert.equal(
    world
      .tenantSql()
      .exec("SELECT starts_refused_in_a_row FROM subscriptions WHERE subscription_id = ?", subscription.subscriptionId)
      .one().starts_refused_in_a_row,
    0,
  );
  await host.finishes(againBusy);
  await host.dropsIdleBox(againBusy);
  const afterSuccess = host.takeOffer();
  assert.equal((afterSuccess.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
  await host.claims(afterSuccess);
  await host.finishes(afterSuccess);
  assert.equal(
    world
      .tenantSql()
      .exec("SELECT starts_refused_in_a_row FROM subscriptions WHERE subscription_id = ?", subscription.subscriptionId)
      .one().starts_refused_in_a_row,
    1,
  );
  const duplicateWritten = world.tenantRowsWritten();
  await host.dropsIdleBox(busy);
  assert.equal(world.tenantRowsWritten() - duplicateWritten, 0);
});

test("ten exponentially spaced refusal and capacity cycles pause StartsRefused with one bounded counter", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    boxCapacity: 2,
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 4096, memoryAvailableMib: 4096 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  assert.equal(
    (await world.fetch(world.owner, "PATCH", `/v1/personas/${foreman.personaId}`, JSON.stringify({ tumpelMcp: true })))
      .status,
    200,
  );
  const subscription = await world.subscribe(foreman, {
    prompt: "handle starts",
    goal: "finish",
    events: ["StartRefused", "CapacityAvailable"],
    crewTags: ["crew:work"],
  });
  const initial = host.takeOffer();
  await host.claims(initial);
  await host.finishes(initial);
  for (let cycle = 0; cycle < 10; cycle++) {
    const filler = await world.startSession({ prompt: "fill the host", tags: [], boxRetention: "Warm" });
    const busy = host.takeOffer();
    assert.equal(busy.sessionId, filler.sessionId);
    await host.claims(busy);
    const refused = await world.fetch(
      world.owner,
      "POST",
      "/v1/sessions",
      JSON.stringify({
        personaId: foreman.personaId,
        repository: "https://github.com/acme/app",
        model: "opus",
        prompt: "crew work",
        tags: ["crew:work"],
      }),
    );
    assert.equal(refused.status, 409);
    assert.equal(ProblemSchema.parse(await refused.json()).code, "PoolExhausted");
    const refusalDelivery = host.takeOffer();
    assert.equal((refusalDelivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
    await host.claims(refusalDelivery);
    await host.finishes(refusalDelivery);
    await host.finishes(busy);
    await world.passes(1000 * 2 ** cycle);
    const written = world.tenantRowsWritten();
    await host.dropsIdleBox(busy);
    assert.equal(world.tenantRowsWritten() - written, 29);
    const capacity = host.takeOffer();
    assert.equal((capacity.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
    await host.claims(capacity);
    await host.finishes(capacity);
    const counter = world
      .tenantSql()
      .exec("SELECT starts_refused_in_a_row FROM subscriptions WHERE subscription_id = ?", subscription.subscriptionId)
      .one();
    assert.equal(counter.starts_refused_in_a_row, cycle + 1);
    assert.equal(world.tenantSql().exec("SELECT subscription_id FROM subscriptions").toArray().length, 1);
    assert.equal(host.holds("TurnOffer"), false);
  }
  const paused = await world.subscription(subscription.subscriptionId);
  assert.equal(paused.state, "Paused");
  assert.deepEqual(paused.reason, { kind: "StartsRefused" });
});

test("one capacity signal serves 101 subscriptions by cursor and excludes a non-room refusal", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    boxCapacity: 2,
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 4096, memoryAvailableMib: 4096 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const initial = host.takeOffer();
  await host.claims(initial);
  const subscriptions = [];
  for (let each = 0; each < 101; each++)
    subscriptions.push(
      await world.subscribe(foreman, {
        prompt: "wait for room",
        goal: "finish",
        events: ["CapacityAvailable"],
        crewTags: [],
      }),
    );
  const paused = subscriptions[100];
  assert.ok(paused);
  assert.equal(
    (
      await world.fetch(
        world.owner,
        "POST",
        `/v1/subscriptions/${paused.subscriptionId}/pause`,
        JSON.stringify({ message: "hold" }),
      )
    ).status,
    200,
  );
  const filler = await world.startSession({ prompt: "fill room", tags: [], boxRetention: "Warm" });
  const busy = host.takeOffer();
  assert.equal(busy.sessionId, filler.sessionId);
  await host.claims(busy);
  await host.finishes(busy);
  const olderRoom = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "older crew attempt",
    }),
  );
  assert.equal(olderRoom.status, 409);
  assert.equal(ProblemSchema.parse(await olderRoom.json()).code, "PoolExhausted");
  const invalid = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "unsupported-model",
      prompt: "invalid work",
    }),
  );
  assert.equal(invalid.status, 422);
  const nonRoomWritten = world.tenantRowsWritten();
  await host.dropsIdleBox(busy);
  assert.equal(world.tenantRowsWritten() - nonRoomWritten, 8);
  await host.finishes(initial);
  assert.equal(host.holds("TurnOffer"), false);
  const nextFiller = await world.startSession({ prompt: "fill again", tags: [], boxRetention: "Warm" });
  const nextBusy = host.takeOffer();
  assert.equal(nextBusy.sessionId, nextFiller.sessionId);
  await host.claims(nextBusy);
  await host.finishes(nextBusy);
  await world.sendTurn(foreman.sessionId, "check the crew");
  const caller = host.takeOffer();
  await host.claims(caller);
  const refusedWritten = world.tenantRowsWritten();
  const refused = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "crew work",
    }),
  );
  assert.equal(refused.status, 409);
  assert.equal(ProblemSchema.parse(await refused.json()).code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - refusedWritten, 2);
  const beforeCapacity = world
    .tenantSql()
    .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
    .toArray().length;
  const written = world.tenantRowsWritten();
  await host.dropsIdleBox(nextBusy);
  assert.equal(world.tenantRowsWritten() - written, 8);
  assert.equal(
    world
      .tenantSql()
      .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
      .toArray().length - beforeCapacity,
    1,
  );
  await host.finishes(caller);
  for (let each = 0; each < 100; each++) {
    const delivery = host.takeOffer();
    assert.equal((delivery.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
    await host.claims(delivery);
    await host.finishes(delivery);
  }
  assert.equal(host.holds("TurnOffer"), false);
  assert.equal((await world.subscription(paused.subscriptionId)).cursorEventId, paused.cursorEventId);
  assert.equal(
    (await world.fetch(world.owner, "POST", `/v1/subscriptions/${paused.subscriptionId}/resume`)).status,
    200,
  );
  const delivery = host.takeOffer();
  assert.equal((delivery.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
  assert.equal(
    world.tenantSql().exec("SELECT subscription_id FROM subscriptions WHERE starts_refused_in_a_row = 1").toArray()
      .length,
    101,
  );
});

test("a host coming online wakes a pending room refusal once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    boxCapacity: 1,
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const turn = host.takeOffer();
  await host.claims(turn);
  await world.subscribe(foreman, {
    prompt: "wait for room",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: [],
  });
  const written = world.tenantRowsWritten();
  const refused = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "crew work",
    }),
  );
  assert.equal(refused.status, 409);
  assert.equal(world.tenantRowsWritten() - written, 2);
  const before = world
    .tenantSql()
    .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
    .toArray().length;
  await world.hostOnline("host-2");
  assert.equal(
    world
      .tenantSql()
      .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
      .toArray().length - before,
    1,
  );
  await host.finishes(turn);
  const delivery = host.takeOffer();
  assert.equal((delivery.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
  await host.claims(delivery);
  await world.hostOnline("host-3");
  assert.equal(
    world
      .tenantSql()
      .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
      .toArray().length - before,
    2,
  );
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});
