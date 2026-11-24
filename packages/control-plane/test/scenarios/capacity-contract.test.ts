import assert from "node:assert/strict";
import { test } from "node:test";
import { ServeConnectorTokenResultSchema } from "@tumpel/schemas";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { TENANT_ID, World } from "./harness/world.ts";

test("capacity keeps a signal paired with the refusal it followed while the recipient is busy", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 4096, memoryAvailableMib: 4096 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const initial = host.takeOffer();
  await host.claims(initial);
  await world.fetch(world.owner, "PATCH", `/v1/personas/${foreman.personaId}`, JSON.stringify({ tumpelMcp: true }));
  await world.subscribe(foreman, {
    prompt: "wait for room",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: ["crew:work"],
  });
  await world.startSession({ prompt: "hold a box", tags: [], boxRetention: "Warm" });
  const busy = host.takeOffer();
  await host.claims(busy);
  await host.finishes(busy);
  const body = JSON.stringify({
    personaId: foreman.personaId,
    repository: "https://github.com/acme/app",
    model: "opus",
    prompt: "crew work",
    tags: ["crew:work"],
  });
  let before = world.tenantRowsWritten();
  const first = await world.fetch(world.owner, "POST", "/v1/sessions", body);
  assert.equal(first.status, 409);
  assert.equal(world.tenantRowsWritten() - before, 3);
  await host.dropsIdleBox(busy);

  await world.startSession({ prompt: "fill the host again", tags: [], boxRetention: "Warm" });
  const refill = host.takeOffer();
  await host.claims(refill);
  before = world.tenantRowsWritten();
  const second = await world.fetch(world.owner, "POST", "/v1/sessions", body);
  assert.equal(second.status, 409);
  assert.equal(world.tenantRowsWritten() - before, 3);
  await host.finishes(initial);
  const delivery = host.takeOffer();
  assert.equal((delivery.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("a smaller crew start leaves the larger room refusal pending", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 4096, memoryAvailableMib: 4096 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const lead = host.takeOffer();
  await host.claims(lead);
  await world.subscribe(foreman, {
    prompt: "wait for room",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: [],
  });
  const { served } = ServeConnectorTokenResultSchema.parse(
    await world.call("serveConnectorToken", { turnId: lead.turnId, connectorId: "tumpel", now: Date.now() }),
  );
  assert.equal(served.kind, "Served");
  const caller = { tenantId: TENANT_ID, token: served.token.accessToken };
  const persona = `/v1/personas/${foreman.personaId}`;
  const request = {
    personaId: foreman.personaId,
    repository: "https://github.com/acme/app",
    model: "opus",
  };
  assert.equal((await world.fetch(world.owner, "PATCH", persona, JSON.stringify({ boxMemoryMib: 4096 }))).status, 200);
  const before = world.tenantRowsWritten();
  const refusal = await world.fetch(
    caller,
    "POST",
    "/v1/sessions",
    JSON.stringify({ ...request, prompt: "large work" }),
  );
  assert.equal(refusal.status, 409);
  assert.equal((await refusal.json()).code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - before, 3);

  assert.equal((await world.fetch(world.owner, "PATCH", persona, JSON.stringify({ boxMemoryMib: 2048 }))).status, 200);
  const started = await world.fetch(
    caller,
    "POST",
    "/v1/sessions",
    JSON.stringify({ ...request, prompt: "small work" }),
  );
  assert.equal(started.status, 200);
  await host.claims(host.takeOffer());
  const spare = await world.hostOnline("host-2");
  await host.finishes(lead);
  const delivery = host.takeOffer();
  assert.match(delivery.prompt, /"event":"CapacityAvailable"/);
  assert.ok(delivery.prompt.includes(spare.hostId));
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("capacity contract rejects inherited tag overflow before recording a malformed preflight event", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  await world.fetch(world.owner, "PATCH", `/v1/personas/${foreman.personaId}`, JSON.stringify({ tumpelMcp: true }));
  await world.subscribe(foreman, {
    prompt: "refused work",
    goal: "finish",
    events: ["StartRefused"],
    crewTags: ["crew:inherited"],
  });
  const initial = host.takeOffer();
  await host.claims(initial);
  const { served } = ServeConnectorTokenResultSchema.parse(
    await world.call("serveConnectorToken", {
      turnId: initial.turnId,
      connectorId: "tumpel",
      now: Date.now(),
    }),
  );
  assert.equal(served.kind, "Served");
  const written = world.tenantRowsWritten();
  const response = await world.fetch(
    { tenantId: TENANT_ID, token: served.token.accessToken },
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "unsupported-model",
      prompt: "crew work",
      tags: Array.from({ length: 16 }, (_, index) => `tag:${index}`),
    }),
  );
  assert.equal(response.status, 422);
  const events = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=StartRefused");
  assert.equal(events.status, 200);
  assert.deepEqual((await events.json()).events, []);
  assert.equal((await response.json()).code, "InvalidRequest");
  assert.equal(world.tenantRowsWritten() - written, 0);
});

test("a smaller pending refusal wakes only matching subscriptions before a larger refusal fits", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 6144, memoryAvailableMib: 6144 },
  });
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const initial = host.takeOffer();
  await host.claims(initial);
  await world.fetch(world.owner, "PATCH", `/v1/personas/${foreman.personaId}`, JSON.stringify({ tumpelMcp: true }));
  const matching = await world.subscribe(foreman, {
    prompt: "crew needs room",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: ["crew:work"],
  });
  const unrelated = await world.subscribe(foreman, {
    prompt: "unrelated crew",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: ["crew:other"],
  });
  const largeOnly = await world.subscribe(foreman, {
    prompt: "large crew needs room",
    goal: "finish",
    events: ["CapacityAvailable"],
    crewTags: ["crew:large"],
  });
  await world.startSession({ prompt: "Auto work", tags: [], boxRetention: "Auto" });
  const auto = host.takeOffer();
  await host.claims(auto);
  await world.startSession({ prompt: "small warm box", tags: [], boxRetention: "Warm" });
  const small = host.takeOffer();
  await host.claims(small);
  await host.finishes(small);

  for (const boxMemoryMib of [4096, 2048]) {
    const resized = await world.fetch(
      world.owner,
      "PATCH",
      `/v1/personas/${foreman.personaId}`,
      JSON.stringify({ boxMemoryMib }),
    );
    assert.equal(resized.status, 200);
    const before = world.tenantRowsWritten();
    const refused = await world.fetch(
      world.owner,
      "POST",
      "/v1/sessions",
      JSON.stringify({
        personaId: foreman.personaId,
        repository: "https://github.com/acme/app",
        model: "opus",
        prompt: `crew needs ${boxMemoryMib} MiB`,
        tags: boxMemoryMib === 4096 ? ["crew:large", "crew:work"] : ["crew:work"],
      }),
    );
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "PoolExhausted");
    assert.equal(world.tenantRowsWritten() - before, 3);
  }

  const beforeSmall = world.tenantRowsWritten();
  await host.dropsIdleBox(small);
  const signalWrites = world.tenantRowsWritten() - beforeSmall;
  await host.finishes(initial);
  const smallWake = host.takeOffer();
  assert.equal(smallWake.sessionId, foreman.sessionId);
  assert.equal((smallWake.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
  assert.equal(signalWrites, 9);
  await host.claims(smallWake);
  await host.finishes(smallWake);
  assert.equal(host.holds("TurnOffer"), false);

  assert.equal((await world.subscription(largeOnly.subscriptionId)).cursorEventId, largeOnly.cursorEventId);
  assert.equal(world.tenantSql().exec("SELECT event_id FROM capacity_rooms").toArray().length, 1);
  await host.finishes(auto);
  const eligible = host.takeOffer();
  assert.match(eligible.prompt, /large crew needs room/);
  await host.claims(eligible);
  await host.finishes(eligible);
  await world.passes(1000);
  const largeWake = host.takeOffer();
  assert.equal(largeWake.sessionId, foreman.sessionId);
  assert.equal((largeWake.prompt.match(/"event":"CapacityAvailable"/g) ?? []).length, 1);
  await host.claims(largeWake);
  await host.finishes(largeWake);
  assert.equal(host.holds("TurnOffer"), false);
  assert.ok((await world.subscription(matching.subscriptionId)).cursorEventId > matching.cursorEventId);
  assert.equal((await world.subscription(unrelated.subscriptionId)).cursorEventId, unrelated.cursorEventId);

  const response = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=CapacityAvailable");
  assert.equal(response.status, 200);
  const { events } = await response.json();
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event: { hostId: string }) => event.hostId),
    [host.hostId, host.hostId],
  );
});

test("capacity contract excludes expired refusals from delivery and public readback even while old rows remain", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "lead work", tags: [], boxRetention: "Warm" });
  const initial = host.takeOffer();
  await host.claims(initial);
  await world.subscribe(foreman, {
    prompt: "retained work",
    goal: "finish",
    events: ["StartRefused", "CapacityAvailable"],
    crewTags: [],
  });
  const payload = JSON.stringify({
    event: "StartRefused",
    operation: "Start",
    personaId: foreman.personaId,
    model: "opus",
    caller: { kind: "Person", principalId: "principal-scenario" },
    crewTags: [],
    refusal: { code: "PoolExhausted", detail: "an expired attempt" },
  });
  const expired = Date.now() - 8 * 24 * 60 * 60 * 1000;
  world.tenantSql().exec("INSERT INTO events (payload, created_at) VALUES (?, ?)", payload, expired);
  world.tenantSql().exec("INSERT INTO events (payload, created_at) VALUES (?, ?)", payload, expired);
  world
    .tenantSql()
    .exec(
      "INSERT INTO room_refusals (event_id, box_memory_mib, box_disk_mib, amd64, arm64) SELECT event_id, 2048, 32768, 1, 0 FROM events WHERE created_at = ?",
      expired,
    );
  await world.hostOnline("host-2");
  assert.equal(world.tenantSql().exec("SELECT event_id FROM events WHERE created_at = ?", expired).toArray().length, 2);
  const response = await world.fetch(
    world.owner,
    "GET",
    "/v1/events?afterEventId=0&event=StartRefused&event=CapacityAvailable",
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).events, []);
  await host.finishes(initial);
  assert.equal(host.holds("TurnOffer"), false);
  assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 0);
});
