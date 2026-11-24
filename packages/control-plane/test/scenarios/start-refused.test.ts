import assert from "node:assert/strict";
import { test } from "node:test";
import { ListEventsResultSchema, PersonaSchema, ProblemSchema, ServeConnectorTokenResultSchema } from "@tumpel/schemas";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { TENANT_ID, World } from "./harness/world.ts";

test("StartRefused records start refusals and delivers the answered problem once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    boxCapacity: 1,
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
  });
  const foreman = await world.startSession({ prompt: "lead the crew", tags: ["role:foreman"] });
  const enabled = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${foreman.personaId}`,
    JSON.stringify({ tumpelMcp: true }),
  );
  assert.equal(enabled.status, 200);
  await world.subscribe(foreman, {
    prompt: "handle refused crew starts",
    goal: "finish the work",
    events: ["StartRefused"],
    crewTags: ["crew:work"],
  });
  const offer = host.takeOffer();
  await host.claims(offer);
  const { served } = ServeConnectorTokenResultSchema.parse(
    await world.call("serveConnectorToken", {
      turnId: offer.turnId,
      connectorId: "tumpel",
      now: Date.now(),
    }),
  );
  assert.equal(served.kind, "Served");
  const member = { tenantId: TENANT_ID, token: served.token.accessToken };
  const body = {
    personaId: foreman.personaId,
    repository: "https://github.com/acme/app",
    model: "opus",
    prompt: "do crew work",
  };
  const before = world.tenantRowsWritten();
  const response = await world.fetch(member, "POST", "/v1/sessions", JSON.stringify(body));
  assert.equal(response.status, 409);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - before, 2);
  const afterFirst = world.tenantRowsWritten();
  const repeated = await world.fetch(member, "POST", "/v1/sessions", JSON.stringify(body));
  assert.equal(repeated.status, 409);
  assert.deepEqual(ProblemSchema.parse(await repeated.json()), problem);
  assert.equal(world.tenantRowsWritten() - afterFirst, 2);
  const { listed } = ListEventsResultSchema.parse(
    await world.call("listEvents", {
      tenantId: TENANT_ID,
      afterEventId: 0,
      events: ["StartRefused"],
      sessionId: null,
      triggerId: null,
    }),
  );
  assert.equal(listed.kind, "Read");
  assert.equal(listed.page.events.length, 2);
  const event = listed.page.events[0];
  assert.equal(event?.event, "StartRefused");
  assert.deepEqual(event.refusal, { code: "PoolExhausted", detail: problem.detail });
  assert.equal(event.operation, "Start");
  assert.equal(event.personaId, foreman.personaId);
  assert.equal(event.model, "opus");
  assert.deepEqual(event.caller, { kind: "Turn", sessionId: foreman.sessionId, turnId: offer.turnId });
  assert.deepEqual(event.crewTags, ["crew:work"]);
  assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 0);
  await host.finishes(offer);
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.match(delivery.prompt, /PoolExhausted/);
  assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 2);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("StartRefused records start-from-issue refusals and delivers the answered problem once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    boxCapacity: 1,
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
  });
  const foreman = await world.startSession({ prompt: "lead the crew", tags: ["role:foreman"] });
  const enabled = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${foreman.personaId}`,
    JSON.stringify({ tumpelMcp: true }),
  );
  assert.equal(enabled.status, 200);
  const persona = PersonaSchema.parse(await enabled.json());
  await world.call("setSecretMember", {
    tenantId: TENANT_ID,
    secretSetId: persona.secretSetId,
    member: { kind: "Variable", name: "GITHUB_TOKEN", value: "ghp-e2e-scenario" },
    githubUser: { githubUserId: 1, login: "scenario" },
    now: Date.now(),
  });
  await world.subscribe(foreman, {
    prompt: "handle refused crew starts",
    goal: "finish the work",
    events: ["StartRefused"],
    crewTags: ["crew:work"],
  });
  const offer = host.takeOffer();
  await host.claims(offer);
  const { served } = ServeConnectorTokenResultSchema.parse(
    await world.call("serveConnectorToken", {
      turnId: offer.turnId,
      connectorId: "tumpel",
      now: Date.now(),
    }),
  );
  assert.equal(served.kind, "Served");
  const member = { tenantId: TENANT_ID, token: served.token.accessToken };
  const body = { personaId: foreman.personaId, owner: "acme", name: "app", issueNumber: 12, model: "opus" };
  const before = world.tenantRowsWritten();
  const response = await world.fetch(member, "POST", "/v1/sessions/from-issue", JSON.stringify(body));
  assert.equal(response.status, 409);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - before, 2);
  const { listed } = ListEventsResultSchema.parse(
    await world.call("listEvents", {
      tenantId: TENANT_ID,
      afterEventId: 0,
      events: ["StartRefused"],
      sessionId: null,
      triggerId: null,
    }),
  );
  assert.equal(listed.kind, "Read");
  assert.equal(listed.page.events.length, 1);
  const event = listed.page.events[0];
  assert.equal(event?.event, "StartRefused");
  assert.deepEqual(event.refusal, { code: "PoolExhausted", detail: problem.detail });
  assert.equal(event.operation, "Start");
  assert.equal(event.personaId, foreman.personaId);
  assert.equal(event.model, "opus");
  assert.deepEqual(event.caller, { kind: "Turn", sessionId: foreman.sessionId, turnId: offer.turnId });
  assert.deepEqual(event.crewTags, ["crew:work"]);
  assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 0);
  await host.finishes(offer);
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.match(delivery.prompt, /PoolExhausted/);
  assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("StartRefused records send refusals and delivers the answered problem once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    boxCapacity: 1,
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
  });
  const target = await world.startSession({ prompt: "crew work", tags: ["crew:work"] });
  const targetTurn = host.takeOffer();
  await host.claims(targetTurn);
  await host.finishes(targetTurn);
  await host.dropsIdleBox(targetTurn);
  const foreman = await world.startSession({ prompt: "lead the crew", tags: ["role:foreman"] });
  const enabled = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${foreman.personaId}`,
    JSON.stringify({ tumpelMcp: true }),
  );
  assert.equal(enabled.status, 200);
  await world.subscribe(foreman, {
    prompt: "handle refused crew starts",
    goal: "finish the work",
    events: ["StartRefused"],
    crewTags: ["crew:other"],
  });
  const offer = host.takeOffer();
  await host.claims(offer);
  const { served } = ServeConnectorTokenResultSchema.parse(
    await world.call("serveConnectorToken", {
      turnId: offer.turnId,
      connectorId: "tumpel",
      now: Date.now(),
    }),
  );
  assert.equal(served.kind, "Served");
  const member = { tenantId: TENANT_ID, token: served.token.accessToken };
  const body = { prompt: "do crew work" };
  const before = world.tenantRowsWritten();
  const response = await world.fetch(member, "POST", `/v1/sessions/${target.sessionId}/turns`, JSON.stringify(body));
  assert.equal(response.status, 409);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - before, 2);
  const { listed } = ListEventsResultSchema.parse(
    await world.call("listEvents", {
      tenantId: TENANT_ID,
      afterEventId: 0,
      events: ["StartRefused"],
      sessionId: null,
      triggerId: null,
    }),
  );
  assert.equal(listed.kind, "Read");
  assert.equal(listed.page.events.length, 1);
  const event = listed.page.events[0];
  assert.equal(event?.event, "StartRefused");
  assert.deepEqual(event.refusal, { code: "PoolExhausted", detail: problem.detail });
  assert.equal(event.operation, "Send");
  assert.equal(event.personaId, foreman.personaId);
  assert.equal(event.model, "opus");
  assert.deepEqual(event.caller, { kind: "Turn", sessionId: foreman.sessionId, turnId: offer.turnId });
  assert.deepEqual(event.crewTags, ["crew:work"]);
  assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 0);
  await host.finishes(offer);
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.match(delivery.prompt, /PoolExhausted/);
  assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("StartRefused records preflight refusals and delivers the answered problem once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    boxCapacity: 1,
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
  });
  const foreman = await world.startSession({ prompt: "lead the crew", tags: ["role:foreman"] });
  const enabled = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${foreman.personaId}`,
    JSON.stringify({ tumpelMcp: true }),
  );
  assert.equal(enabled.status, 200);
  await world.subscribe(foreman, {
    prompt: "handle refused crew starts",
    goal: "finish the work",
    events: ["StartRefused"],
    crewTags: ["crew:work"],
  });
  const offer = host.takeOffer();
  await host.claims(offer);
  const { served } = ServeConnectorTokenResultSchema.parse(
    await world.call("serveConnectorToken", {
      turnId: offer.turnId,
      connectorId: "tumpel",
      now: Date.now(),
    }),
  );
  assert.equal(served.kind, "Served");
  const member = { tenantId: TENANT_ID, token: served.token.accessToken };
  const body = {
    personaId: foreman.personaId,
    repository: "https://github.com/acme/app",
    model: "unsupported-model",
    prompt: "do crew work",
  };
  const before = world.tenantRowsWritten();
  const response = await world.fetch(member, "POST", "/v1/sessions", JSON.stringify(body));
  assert.equal(response.status, 422);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "ModelUnsupported");
  assert.equal(world.tenantRowsWritten() - before, 2);
  const { listed } = ListEventsResultSchema.parse(
    await world.call("listEvents", {
      tenantId: TENANT_ID,
      afterEventId: 0,
      events: ["StartRefused"],
      sessionId: null,
      triggerId: null,
    }),
  );
  assert.equal(listed.kind, "Read");
  assert.equal(listed.page.events.length, 1);
  const event = listed.page.events[0];
  assert.equal(event?.event, "StartRefused");
  assert.deepEqual(event.refusal, { code: "ModelUnsupported", detail: problem.detail });
  assert.equal(event.operation, "Start");
  assert.equal(event.personaId, foreman.personaId);
  assert.equal(event.model, "unsupported-model");
  assert.deepEqual(event.caller, { kind: "Turn", sessionId: foreman.sessionId, turnId: offer.turnId });
  assert.deepEqual(event.crewTags, ["crew:work"]);
  assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 0);
  await host.finishes(offer);
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.match(delivery.prompt, /ModelUnsupported/);
  assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("a refusal waits behind a paused subscription cursor and delivers on resume", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "lead the crew", tags: [] });
  const turn = host.takeOffer();
  await host.claims(turn);
  await host.finishes(turn);
  const subscription = await world.subscribe(foreman, {
    prompt: "handle refused starts",
    goal: "finish",
    events: ["StartRefused"],
    crewTags: [],
  });
  const path = `/v1/subscriptions/${subscription.subscriptionId}`;
  assert.equal(
    (await world.fetch(world.owner, "POST", `${path}/pause`, JSON.stringify({ message: "hold" }))).status,
    200,
  );
  const written = world.tenantRowsWritten();
  const response = await world.fetch(
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
  assert.equal(response.status, 422);
  assert.equal(ProblemSchema.parse(await response.json()).code, "ModelUnsupported");
  assert.equal(
    world.tenantSql().exec("SELECT * FROM events WHERE json_extract(payload, '$.event') = 'StartRefused'").toArray()
      .length,
    1,
  );
  assert.equal(world.tenantRowsWritten() - written, 2);
  assert.equal(host.holds("TurnOffer"), false);
  assert.equal((await world.subscription(subscription.subscriptionId)).cursorEventId, subscription.cursorEventId);
  assert.equal((await world.fetch(world.owner, "POST", `${path}/resume`)).status, 200);
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.match(delivery.prompt, /ModelUnsupported/);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("one refusal writes one event for 101 subscriptions and preserves a paused cursor", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "lead the crew", tags: [] });
  const turn = host.takeOffer();
  await host.claims(turn);
  const subscriptions = [];
  for (let each = 0; each < 101; each++) {
    subscriptions.push(
      await world.subscribe(foreman, {
        prompt: "handle refused starts",
        goal: "finish",
        events: ["StartRefused"],
        crewTags: [],
      }),
    );
  }
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
  const { served } = ServeConnectorTokenResultSchema.parse(
    await world.call("serveConnectorToken", {
      turnId: turn.turnId,
      connectorId: "tumpel",
      now: Date.now(),
    }),
  );
  assert.equal(served.kind, "Served");
  const member = { tenantId: TENANT_ID, token: served.token.accessToken };
  const written = world.tenantRowsWritten();
  const response = await world.fetch(
    member,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "unsupported-model",
      prompt: "crew work",
    }),
  );
  assert.equal(response.status, 422);
  assert.equal(ProblemSchema.parse(await response.json()).code, "ModelUnsupported");
  assert.equal(
    world.tenantSql().exec("SELECT * FROM events WHERE json_extract(payload, '$.event') = 'StartRefused'").toArray()
      .length,
    1,
  );
  assert.equal(world.tenantSql().exec("SELECT * FROM subscription_turns").toArray().length, 0);
  assert.equal(world.tenantRowsWritten() - written, 2);
  await host.finishes(turn);
  for (let each = 0; each < 100; each++) {
    const delivery = host.takeOffer();
    assert.equal(delivery.sessionId, foreman.sessionId);
    assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
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
  assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
  const delivered = world.tenantSql().exec("SELECT subscription_id, cursor_event_id FROM subscriptions").toArray();
  assert.equal(delivered.length, 101);
  assert.equal(new Set(delivered.map((row) => row.cursor_event_id)).size, 1);
});

test("a refusal without a catalog version records the attempt without inventing a version", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "start work", tags: [] });
  const turn = host.takeOffer();
  await host.claims(turn);
  await host.finishes(turn);
  await world.call("pin", { pin: { harness: "ClaudeCode", harnessVersion: "removed-version" }, now: Date.now() });
  const written = world.tenantRowsWritten();
  const response = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: session.personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "try another start",
    }),
  );
  assert.equal(response.status, 422);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "HarnessNotInCatalog");
  assert.equal(world.tenantRowsWritten() - written, 2);
  const { listed } = ListEventsResultSchema.parse(
    await world.call("listEvents", {
      tenantId: TENANT_ID,
      afterEventId: 0,
      events: ["StartRefused"],
      sessionId: null,
      triggerId: null,
    }),
  );
  assert.equal(listed.kind, "Read");
  assert.equal(listed.page.events.length, 1);
  const event = listed.page.events[0];
  assert.equal(event?.event, "StartRefused");
  assert.deepEqual(event.refusal, { code: "HarnessNotInCatalog", detail: problem.detail });
  assert.equal("harnessVersion" in event, false);
  assert.equal(event.caller.kind, "Person");
});

test("delivery composition matches a refusal's crew tags without a calling session", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "lead the crew", tags: [] });
  const enabled = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${foreman.personaId}`,
    JSON.stringify({ tumpelMcp: true }),
  );
  assert.equal(enabled.status, 200);
  const matched = await world.subscribe(foreman, {
    prompt: "handle work refusals",
    goal: "finish work",
    events: ["StartRefused"],
    crewTags: ["crew:work"],
  });
  const unmatched = await world.subscribe(foreman, {
    prompt: "handle other refusals",
    goal: "finish other work",
    events: ["StartRefused"],
    crewTags: ["crew:other"],
  });
  const turn = host.takeOffer();
  await host.claims(turn);
  const written = world.tenantRowsWritten();
  const response = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: "https://github.com/acme/app",
      model: "unsupported-model",
      prompt: "crew work",
      tags: ["crew:work"],
    }),
  );
  assert.equal(response.status, 422);
  assert.equal(ProblemSchema.parse(await response.json()).code, "ModelUnsupported");
  assert.equal(world.tenantRowsWritten() - written, 2);
  await host.finishes(turn);
  const delivery = host.takeOffer();
  assert.match(delivery.prompt, /handle work refusals/);
  assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
  assert.ok((await world.subscription(matched.subscriptionId)).cursorEventId > matched.cursorEventId);
  assert.equal((await world.subscription(unmatched.subscriptionId)).cursorEventId, unmatched.cursorEventId);
});

test("refusal appends prune one expired event per request independently of the backlog", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "start work", tags: [] });
  const turn = host.takeOffer();
  await host.claims(turn);
  for (let each = 0; each < 101; each++) {
    world
      .tenantSql()
      .exec(
        "INSERT INTO events (payload, created_at) VALUES (?, ?)",
        JSON.stringify({ event: "HostOnline", hostId: host.hostId }),
        Date.now() - 8 * 24 * 60 * 60 * 1000,
      );
  }
  for (let each = 0; each < 3; each++) {
    const written = world.tenantRowsWritten();
    const refused = await world.fetch(
      world.owner,
      "POST",
      "/v1/sessions",
      JSON.stringify({
        personaId: session.personaId,
        repository: "https://github.com/acme/app",
        model: "unsupported-model",
        prompt: "crew work",
      }),
    );
    assert.equal(refused.status, 422);
    assert.equal(world.tenantRowsWritten() - written, 4);
    assert.equal(
      world
        .tenantSql()
        .exec("SELECT event_id FROM events WHERE created_at < ?", Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toArray().length,
      100 - each,
    );
  }
});
