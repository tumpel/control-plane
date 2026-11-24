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
    assert.equal(world.tenantRowsWritten() - written, cycle === 0 ? 29 : 9);
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
  assert.match(delivery.prompt, /"code":"NoHostAvailable"/);
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

test("a fresh hello reports newly freed room before any heartbeat", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 4096, memoryAvailableMib: 4096 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const initial = host.takeOffer();
  await host.claims(initial);
  await host.finishes(initial);
  await world.subscribe(foreman, {
    prompt: "wait for room",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: [],
  });
  host.report({ memoryHeldMib: 4096 });
  await world.settle();
  const denied = await world.fetch(
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
  assert.equal(denied.status, 409);
  assert.equal(host.holds("TurnOffer"), false);
  const before = world.tenantRowsWritten();
  const back = await world.reconnect(host, {
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 4096, memoryHeldMib: 2048, memoryAvailableMib: 2048 },
  });
  assert.match(back.takeOffer().prompt, /"event":"CapacityAvailable"/);
  assert.ok(world.tenantRowsWritten() - before <= 32);
});

test("archiving a box and failing a session each release room before a heartbeat", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 4096, memoryAvailableMib: 4096 },
  });
  host.quiet();
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const initial = host.takeOffer();
  await host.claims(initial);
  await host.finishes(initial);
  await world.subscribe(foreman, {
    prompt: "wait for room",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: [],
  });
  const body = JSON.stringify({
    personaId: foreman.personaId,
    repository: "https://github.com/acme/app",
    model: "opus",
    prompt: "crew work",
  });
  const archived = await world.startSession({ prompt: "box to archive", tags: [], boxRetention: "Warm" });
  const old = host.takeOffer();
  await host.claims(old);
  await host.finishes(old);
  assert.equal((await world.fetch(world.owner, "POST", "/v1/sessions", body)).status, 409);
  const archiveWrites = world.tenantRowsWritten();
  assert.equal((await world.fetch(world.owner, "POST", `/v1/sessions/${archived.sessionId}/archive`)).status, 200);
  const afterArchive = host.takeOffer();
  assert.match(afterArchive.prompt, /"event":"CapacityAvailable".*"code":"PoolExhausted"/);
  assert.ok(world.tenantRowsWritten() - archiveWrites <= 40);
  await host.claims(afterArchive);
  await host.finishes(afterArchive);

  const failed = await world.startSession({ prompt: "box that cannot clone", tags: [], boxRetention: "Warm" });
  const clone = host.takeOffer();
  assert.equal(clone.sessionId, failed.sessionId);
  await host.claims(clone);
  assert.equal((await world.fetch(world.owner, "POST", "/v1/sessions", body)).status, 409);
  await world.tick(1000);
  const failureWrites = world.tenantRowsWritten();
  await host.says({
    type: "TurnRepositoryCloneFailed",
    turnId: clone.turnId,
    cause: "Refused",
    detail: "The repository refused the clone.",
    failedAt: new Date().toISOString(),
  });
  assert.equal((await world.session(failed.sessionId)).state, "Failed");
  const afterFailure = host.takeOffer();
  assert.match(afterFailure.prompt, /"event":"CapacityAvailable".*"code":"PoolExhausted"/);
  assert.ok(world.tenantRowsWritten() - failureWrites <= 45);
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

test("unclaimed refusal offers do not block the next delivery batch", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  host.quiet();
  const foremen = [];
  for (let each = 0; each < 9; each++) {
    const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
    const initial = host.takeOffer();
    await host.claims(initial);
    await host.finishes(initial);
    await world.subscribe(foreman, {
      prompt: "handle refused starts",
      goal: "finish",
      events: ["StartRefused"],
      crewTags: [],
    });
    foremen.push(foreman);
  }
  const [first] = foremen;
  assert.ok(first);
  const before = world.tenantRowsWritten();
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
  assert.ok(world.tenantRowsWritten() - before <= 191);
  const deliveries = foremen.map(() => host.takeOffer());
  assert.equal(host.holds("TurnOffer"), false);
  assert.deepEqual(
    new Set(deliveries.map((turn) => turn.sessionId)),
    new Set(foremen.map(({ sessionId }) => sessionId)),
  );
  for (const delivery of deliveries) {
    assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
    await host.claims(delivery);
    await host.finishes(delivery);
  }
  assert.equal(host.holds("TurnOffer"), false);
});

test("a failed capacity offer keeps its signal and retries after backoff on the foreman's host", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const initial = host.takeOffer();
  await host.claims(initial);
  await host.finishes(initial);
  const subscription = await world.subscribe(foreman, {
    prompt: "wait for room",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: [],
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
  await host.closesSocket();
  const spare = await world.hostOnline("host-2");
  spare.quiet();
  const state = world
    .tenantSql()
    .exec(
      "SELECT cursor_event_id, capacity_event_id, refusal_delivery_attempts, refusal_delivery_retry_at FROM subscriptions WHERE subscription_id = ?",
      subscription.subscriptionId,
    )
    .one();
  assert.equal(state.cursor_event_id, subscription.cursorEventId);
  assert.equal(state.capacity_event_id, 0);
  assert.equal(state.refusal_delivery_attempts, 1);

  const back = await world.reconnect(host);
  back.quiet();
  const remaining = Number(state.refusal_delivery_retry_at) - Date.now();
  assert.ok(remaining > 0);
  await world.tick(remaining - 1);
  assert.equal(back.holds("TurnOffer"), false);
  const before = world.tenantRowsWritten();
  await world.restartTenant();
  await world.tick(1);
  await spare.beats();
  const retry = back.takeOffer();
  assert.match(retry.prompt, /"event":"CapacityAvailable"/);
  assert.equal((await world.subscription(subscription.subscriptionId)).cursorEventId, subscription.cursorEventId);
  assert.ok(world.tenantRowsWritten() - before <= 22);
  await back.claims(retry);
  await back.finishes(retry);
  assert.ok((await world.subscription(subscription.subscriptionId)).cursorEventId > subscription.cursorEventId);
  assert.equal(world.tenantSql().exec("SELECT event_id FROM capacity_rooms").toArray().length, 1);
});

test("ten failed refusal offers pause only the subscription whose host cannot deliver", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const initial = host.takeOffer();
  await host.claims(initial);
  await host.finishes(initial);
  const subscription = await world.subscribe(foreman, {
    prompt: "handle refusal",
    goal: "finish",
    events: ["StartRefused"],
    crewTags: [],
  });
  const spare = await world.hostOnline("host-2");
  spare.quiet();
  const other = await world.startSession({ prompt: "lead other work", tags: [], boxRetention: "Warm" });
  const otherTurn = spare.takeOffer();
  await spare.claims(otherTurn);
  await spare.finishes(otherTurn);
  const healthy = await world.subscribe(other, {
    prompt: "handle refusal too",
    goal: "finish",
    events: ["StartRefused"],
    crewTags: [],
  });
  await host.closesSocket();
  const refused = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "unsupported-model",
      prompt: "crew work",
    }),
  );
  assert.equal(refused.status, 422);
  const delivered = spare.takeOffer();
  assert.match(delivered.prompt, /"event":"StartRefused"/);
  await spare.claims(delivered);
  await spare.finishes(delivered);
  assert.ok((await world.subscription(healthy.subscriptionId)).cursorEventId > healthy.cursorEventId);
  for (let attempt = 1; attempt <= 10; attempt++) {
    const progress = world
      .tenantSql()
      .exec(
        "SELECT refusal_delivery_attempts, refusal_delivery_retry_at, start_refusal_event_id FROM subscriptions WHERE subscription_id = ?",
        subscription.subscriptionId,
      )
      .one();
    assert.equal(progress.refusal_delivery_attempts, attempt);
    assert.equal(progress.start_refusal_event_id, 0);
    if (attempt === 10) {
      assert.equal(progress.refusal_delivery_retry_at, 0);
      break;
    }
    const wait = Number(progress.refusal_delivery_retry_at) - Date.now();
    assert.ok(wait > 0 && wait <= 1000 * 2 ** (attempt - 1));
    const before = world.tenantRowsWritten();
    await world.tick(wait - 1);
    assert.equal(world.tenantRowsWritten() - before, 0);
    await world.tick(1);
    await spare.beats();
    assert.ok(world.tenantRowsWritten() - before <= 50);
  }
  const paused = await world.subscription(subscription.subscriptionId);
  assert.equal(paused.state, "Paused");
  assert.equal(paused.reason.kind, "DeliveryFailed");
  assert.equal((await world.subscription(healthy.subscriptionId)).state, "Active");
  const pausedWrites = world.tenantRowsWritten();
  await world.tick(512_000);
  assert.equal(world.tenantRowsWritten(), pausedWrites);
  assert.equal(
    world
      .tenantSql()
      .exec(
        "SELECT refusal_delivery_attempts FROM subscriptions WHERE subscription_id = ?",
        subscription.subscriptionId,
      )
      .one().refusal_delivery_attempts,
    10,
  );
});

test("a crew turn can be delivered while an earlier start refusal waits to retry", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const lead = host.takeOffer();
  await host.claims(lead);
  await host.finishes(lead);
  const spare = await world.hostOnline("host-2");
  spare.quiet();
  const crew = await world.startSession({ prompt: "crew work", tags: [], boxRetention: "Warm" });
  const work = spare.takeOffer();
  await spare.claims(work);
  await world.subscribe(foreman, {
    prompt: "handle work",
    goal: "finish",
    events: ["StartRefused", "TurnCompleted"],
    crewTags: [],
  });

  await host.closesSocket();
  const refused = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: crew.personaId,
      repository: "https://github.com/acme/app",
      model: "unsupported-model",
      prompt: "more crew work",
    }),
  );
  assert.equal(refused.status, 422);
  const readback = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=StartRefused");
  assert.equal(readback.status, 200);
  const { events } = await readback.json();
  assert.equal(events.length, 1);
  const back = await world.reconnect(host);
  back.quiet();

  await spare.finishes(work);
  const crewDelivery = back.takeOffer();
  assert.match(crewDelivery.prompt, /"event":"TurnCompleted"/);
  assert.doesNotMatch(crewDelivery.prompt, /"event":"StartRefused"/);
  await back.claims(crewDelivery);
  await back.finishes(crewDelivery);
  const before = world.tenantRowsWritten();
  await world.tick(1000);
  assert.ok(world.tenantRowsWritten() - before <= 22);
  await spare.beats();
  const retry = back.takeOffer();
  assert.deepEqual(
    retry.prompt
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line)),
    events,
  );
  await back.claims(retry);
  await back.finishes(retry);
  assert.equal(back.holds("TurnOffer"), false);
});

test("a resumed refusal backs off when the stopped subscriber cannot place a delivery", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const lead = host.takeOffer();
  await host.claims(lead);
  await host.finishes(lead);
  const subscription = await world.subscribe(foreman, {
    prompt: "handle refusals",
    goal: "finish",
    events: ["StartRefused"],
    crewTags: [],
  });
  const path = `/v1/subscriptions/${subscription.subscriptionId}`;
  const paused = await world.fetch(world.owner, "POST", `${path}/pause`, JSON.stringify({ message: "hold" }));
  assert.equal(paused.status, 200);
  await host.dropsIdleBox(lead);
  await world.startSession({ prompt: "fill the only host", tags: [], boxRetention: "Warm" });
  await host.claims(host.takeOffer());
  const refused = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "unsupported-model",
      prompt: "crew work",
    }),
  );
  assert.equal(refused.status, 422);
  const before = world.tenantRowsWritten();
  assert.equal((await world.fetch(world.owner, "POST", `${path}/resume`)).status, 200);
  const progress = world
    .tenantSql()
    .exec(
      "SELECT refusal_delivery_attempts, refusal_delivery_retry_at, delivery_failures_in_a_row FROM subscriptions WHERE subscription_id = ?",
      subscription.subscriptionId,
    )
    .one();
  assert.equal(progress.refusal_delivery_attempts, 1);
  assert.equal(progress.delivery_failures_in_a_row, 0);
  assert.ok(Number(progress.refusal_delivery_retry_at) > Date.now());
  assert.ok(world.tenantRowsWritten() - before <= 35);
  const current = await world.subscription(subscription.subscriptionId);
  assert.equal(current.state, "Active");
  assert.equal(current.cursorEventId, subscription.cursorEventId);
  assert.equal(host.holds("TurnOffer"), false);
});
