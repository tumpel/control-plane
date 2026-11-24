import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol, ProblemSchema, ServeConnectorTokenResultSchema } from "@tumpel/schemas";
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
  assert.equal(world.tenantRowsWritten() - written, 3);
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
  assert.equal(world.tenantRowsWritten() - capacityWritten, 30);
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
  world
    .tenantSql()
    .exec(
      "DELETE FROM events WHERE json_extract(payload, '$.event') = 'SessionStarted' AND json_extract(payload, '$.sessionId') = ?",
      crew.sessionId,
    );
  await world.restartTenant();
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

  const block = await world.startSession({ prompt: "hold capacity again", tags: [], boxRetention: "Warm" });
  const blocker = host.takeOffer();
  assert.equal(blocker.sessionId, block.sessionId);
  await host.claims(blocker);
  const { served: latestToken } = ServeConnectorTokenResultSchema.parse(
    await world.call("serveConnectorToken", { turnId: afterSuccess.turnId, connectorId: "tumpel", now: Date.now() }),
  );
  assert.equal(latestToken.kind, "Served");
  const caller = { tenantId: TENANT_ID, token: latestToken.token.accessToken };
  const attempt = JSON.stringify({
    personaId: foreman.personaId,
    repository: "https://github.com/acme/app",
    model: "opus",
    prompt: "try crew work",
  });
  assert.equal((await world.fetch(caller, "POST", "/v1/sessions", attempt)).status, 409);
  await host.finishes(blocker);
  await host.dropsIdleBox(blocker);
  assert.equal((await world.fetch(caller, "POST", "/v1/sessions", attempt)).status, 200);
  const started = host.takeOffer();
  await host.claims(started);
  await host.finishes(afterSuccess);
  const recordedRefusal = host.takeOffer();
  assert.match(recordedRefusal.prompt, /StartRefused/);
  assert.doesNotMatch(recordedRefusal.prompt, /CapacityAvailable/);
  await host.claims(recordedRefusal);
  await host.finishes(recordedRefusal);
  await host.finishes(started);
  await host.dropsIdleBox(started);
  assert.equal(host.holds("TurnOffer"), false, "a successful start clears the earlier pending room refusal");
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
    const written = world.tenantRowsWritten();
    await host.dropsIdleBox(busy);
    assert.equal(world.tenantRowsWritten() - written, cycle === 0 ? 30 : 9);
    if (cycle > 0) {
      if (cycle === 1) {
        const intervening = await world.fetch(
          world.owner,
          "POST",
          "/v1/sessions",
          JSON.stringify({
            personaId: foreman.personaId,
            repository: "https://github.com/acme/app",
            model: "unsupported-model",
            prompt: "ordinary refusal during capacity backoff",
            tags: ["crew:work"],
          }),
        );
        assert.equal(ProblemSchema.parse(await intervening.json()).code, "ModelUnsupported");
        const ordinary = host.takeOffer();
        assert.match(ordinary.prompt, /ModelUnsupported/);
        assert.doesNotMatch(ordinary.prompt, /CapacityAvailable/);
        await host.claims(ordinary);
        await host.finishes(ordinary);
      }
      const due = world
        .tenantSql()
        .exec("SELECT capacity_retry_at FROM subscriptions WHERE subscription_id = ?", subscription.subscriptionId)
        .one();
      const remaining = Number(due.capacity_retry_at) - Date.now();
      assert.ok(remaining > 0);
      assert.equal(host.holds("TurnOffer"), false);
      await world.passes(remaining - 1);
      assert.equal(host.holds("TurnOffer"), false);
      if (cycle === 1) {
        host.quiet();
        await world.tick(1);
        await host.beats();
        assert.equal(
          host.holds("TurnOffer"),
          true,
          "the earlier capacity signal survives the ordinary refusal and backoff",
        );
        host.resumes();
      } else {
        await world.passes(1001);
      }
    }
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

test("a room refusal survives a later catalog refusal and one capacity signal waits for active and paused recipients", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    boxCapacity: 2,
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 4096, memoryAvailableMib: 4096 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const initial = host.takeOffer();
  await host.claims(initial);
  await world.subscribe(foreman, {
    prompt: "wait for room",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: [],
  });
  const paused = await world.subscribe(foreman, {
    prompt: "wait until resumed",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: [],
  });
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
  const refusedWritten = world.tenantRowsWritten();
  const room = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "crew attempt",
    }),
  );
  assert.equal(room.status, 409);
  assert.equal(ProblemSchema.parse(await room.json()).code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - refusedWritten, 3);
  await world.passes(1000);
  await world.call("pin", { pin: { harness: "ClaudeCode", harnessVersion: "removed-version" }, now: Date.now() });
  const catalogWritten = world.tenantRowsWritten();
  const catalog = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "another crew attempt",
    }),
  );
  assert.equal(catalog.status, 422);
  assert.equal(ProblemSchema.parse(await catalog.json()).code, "HarnessNotInCatalog");
  assert.equal(world.tenantRowsWritten() - catalogWritten, 2);
  await world.call("unpin", { harness: "ClaudeCode" });
  await world.passes(1000);
  const written = world.tenantRowsWritten();
  await host.dropsIdleBox(busy);
  assert.equal(world.tenantRowsWritten() - written, 9);
  await world.hostOnline("host-2");
  await world.hostOnline("host-3");
  assert.equal(
    world
      .tenantSql()
      .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
      .toArray().length,
    1,
  );
  await host.finishes(initial);
  const activeDelivery = host.takeOffer();
  assert.equal((activeDelivery.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
  await host.claims(activeDelivery);
  await host.finishes(activeDelivery);
  assert.equal(host.holds("TurnOffer"), false);
  assert.equal((await world.subscription(paused.subscriptionId)).cursorEventId, paused.cursorEventId);
  await world.hostOnline("host-4");
  assert.equal(
    world
      .tenantSql()
      .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
      .toArray().length,
    1,
  );
  assert.equal(
    (await world.fetch(world.owner, "POST", `/v1/subscriptions/${paused.subscriptionId}/resume`)).status,
    200,
  );
  const pausedDelivery = host.takeOffer();
  assert.equal((pausedDelivery.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
  await host.claims(pausedDelivery);
  await host.finishes(pausedDelivery);
  assert.equal(host.holds("TurnOffer"), false);
  assert.equal(
    world.tenantSql().exec("SELECT subscription_id FROM subscriptions WHERE starts_refused_in_a_row = 1").toArray()
      .length,
    2,
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
  assert.equal(world.tenantRowsWritten() - written, 3);
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
    1,
  );
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("ordinary host-online and box-stop transitions append no capacity signal", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  assert.equal(
    world
      .tenantSql()
      .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
      .toArray().length,
    0,
  );
  await world.startSession({ prompt: "ordinary work", tags: [], boxRetention: "Warm" });
  const turn = host.takeOffer();
  await host.claims(turn);
  await host.finishes(turn);
  const written = world.tenantRowsWritten();
  await host.dropsIdleBox(turn);
  assert.equal(world.tenantRowsWritten() - written, 6);
  assert.equal(
    world
      .tenantSql()
      .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
      .toArray().length,
    0,
  );
});

test("a healthy heartbeat on the same connection wakes a room refusal once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const initial = host.takeOffer();
  await host.claims(initial);
  await host.finishes(initial);
  await world.subscribe(foreman, {
    prompt: "wait for a healthy host",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: [],
  });
  await world.call("hostHeartbeat", {
    tenantId: TENANT_ID,
    hostId: host.hostId,
    channelProtocol: ChannelProtocol.Version,
    boxCapacity: 2,
    usage: DEFAULT_USAGE,
    reportedHealth: "RateLimited",
    now: Date.now(),
    ...host.holding(),
  });
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
  assert.equal(host.holds("TurnOffer"), false);
  await host.beats();
  const ready = host.takeOffer();
  assert.equal(ready.sessionId, foreman.sessionId);
  assert.equal((ready.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
  await host.claims(ready);
  await host.finishes(ready);
  const written = world.tenantRowsWritten();
  await host.beats();
  assert.equal(world.tenantRowsWritten() - written, 0);
  assert.equal(host.holds("TurnOffer"), false);
});

test("a disk-only report after BoxGone releases the pending wake", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const initial = host.takeOffer();
  await host.claims(initial);
  await host.finishes(initial);
  await world.subscribe(foreman, {
    prompt: "wait for disk",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: [],
  });
  await world.startSession({ prompt: "hold disk", tags: [], boxRetention: "Warm" });
  const filler = host.takeOffer();
  await host.claims(filler);
  await host.finishes(filler);
  host.report({ memoryBudgetMib: 30001, diskBudgetMib: 65536, diskHeldMib: 65536 });
  await world.settle();
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
  await host.dropsIdleBox(filler);
  assert.equal(host.holds("TurnOffer"), false);
  host.report({ diskHeldMib: 32768 });
  await world.settle();
  const wake = host.takeOffer();
  assert.equal(wake.sessionId, foreman.sessionId);
  assert.equal((wake.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
  await host.claims(wake);
  await host.finishes(wake);
  await host.beats();
  assert.equal(host.holds("TurnOffer"), false);
});

test("a refusal queues one idle recipient and its delivery transition queues the next", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const first = await world.startSession({ prompt: "first foreman", tags: [], boxRetention: "Warm" });
  const firstTurn = host.takeOffer();
  await host.claims(firstTurn);
  await host.finishes(firstTurn);
  await world.subscribe(first, {
    prompt: "first refused starts",
    goal: "finish",
    events: ["StartRefused"],
    crewTags: [],
  });
  const second = await world.startSession({ prompt: "second foreman", tags: [], boxRetention: "Warm" });
  const secondTurn = host.takeOffer();
  await host.claims(secondTurn);
  await host.finishes(secondTurn);
  await world.subscribe(second, {
    prompt: "second refused starts",
    goal: "finish",
    events: ["StartRefused"],
    crewTags: [],
  });
  const refused = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: first.personaId,
      repository: "https://github.com/acme/app",
      model: "unsupported-model",
      prompt: "crew work",
    }),
  );
  assert.equal(refused.status, 422);
  assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 1);
  const delivery = host.takeOffer();
  assert.equal(host.holds("TurnOffer"), false);
  await host.claims(delivery);
  const next = host.takeOffer();
  assert.deepEqual(new Set([delivery.sessionId, next.sessionId]), new Set([first.sessionId, second.sessionId]));
  assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
  assert.equal((next.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
  await host.claims(next);
  await host.finishes(delivery);
  await host.finishes(next);
  assert.equal(host.holds("TurnOffer"), false);
});
