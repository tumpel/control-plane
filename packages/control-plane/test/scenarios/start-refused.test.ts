import assert from "node:assert/strict";
import { test } from "node:test";
import { ListEventsResultSchema, PersonaSchema, ProblemSchema, ServeConnectorTokenResultSchema } from "@tumpel/schemas";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { TENANT_ID, World } from "./harness/world.ts";

test("StartRefused coalesces start refusals and delivers the answered problem once", async (t) => {
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
  const path = "/v1/sessions";
  const body = {
    personaId: foreman.personaId,
    repository: "https://github.com/acme/app",
    model: "opus",
    prompt: "do crew work",
  };
  const before = world.tenantRowsWritten();
  const response = await world.fetch(member, "POST", path, JSON.stringify(body));
  assert.equal(response.status, 409);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - before, 13);
  const afterFirst = world.tenantRowsWritten();
  for (let attempt = 0; attempt < 5; attempt++) {
    const repeated = await world.fetch(member, "POST", path, JSON.stringify(body));
    assert.equal(repeated.status, 409);
    assert.deepEqual(ProblemSchema.parse(await repeated.json()), problem);
  }
  assert.equal(world.tenantRowsWritten() - afterFirst, 0);
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
  assert.deepEqual(event.crewTags, ["crew:work"]);
  assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 1);
  await host.finishes(offer);
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.match(delivery.prompt, /PoolExhausted/);
  assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("StartRefused coalesces start-from-issue refusals and delivers the answered problem once", async (t) => {
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
  const path = "/v1/sessions/from-issue";
  const body = { personaId: foreman.personaId, owner: "acme", name: "app", issueNumber: 12, model: "opus" };
  const before = world.tenantRowsWritten();
  const response = await world.fetch(member, "POST", path, JSON.stringify(body));
  assert.equal(response.status, 409);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - before, 13);
  const afterFirst = world.tenantRowsWritten();
  for (let attempt = 0; attempt < 5; attempt++) {
    const repeated = await world.fetch(member, "POST", path, JSON.stringify(body));
    assert.equal(repeated.status, 409);
    assert.deepEqual(ProblemSchema.parse(await repeated.json()), problem);
  }
  assert.equal(world.tenantRowsWritten() - afterFirst, 0);
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
  assert.deepEqual(event.crewTags, ["crew:work"]);
  assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 1);
  await host.finishes(offer);
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.match(delivery.prompt, /PoolExhausted/);
  assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("StartRefused coalesces send refusals and delivers the answered problem once", async (t) => {
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
  const path = `/v1/sessions/${target.sessionId}/turns`;
  const body = { prompt: "do crew work" };
  const before = world.tenantRowsWritten();
  const response = await world.fetch(member, "POST", path, JSON.stringify(body));
  assert.equal(response.status, 409);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - before, 13);
  const afterFirst = world.tenantRowsWritten();
  for (let attempt = 0; attempt < 5; attempt++) {
    const repeated = await world.fetch(member, "POST", path, JSON.stringify(body));
    assert.equal(repeated.status, 409);
    assert.deepEqual(ProblemSchema.parse(await repeated.json()), problem);
  }
  assert.equal(world.tenantRowsWritten() - afterFirst, 0);
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
  assert.deepEqual(event.crewTags, ["crew:work"]);
  assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 1);
  await host.finishes(offer);
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.match(delivery.prompt, /PoolExhausted/);
  assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("StartRefused coalesces preflight refusals and delivers the answered problem once", async (t) => {
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
  const path = "/v1/sessions";
  const body = {
    personaId: foreman.personaId,
    repository: "https://github.com/acme/app",
    model: "unsupported-model",
    prompt: "do crew work",
  };
  const before = world.tenantRowsWritten();
  const response = await world.fetch(member, "POST", path, JSON.stringify(body));
  assert.equal(response.status, 422);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "ModelUnsupported");
  assert.equal(world.tenantRowsWritten() - before, 13);
  const afterFirst = world.tenantRowsWritten();
  for (let attempt = 0; attempt < 5; attempt++) {
    const repeated = await world.fetch(member, "POST", path, JSON.stringify(body));
    assert.equal(repeated.status, 422);
    assert.deepEqual(ProblemSchema.parse(await repeated.json()), problem);
  }
  assert.equal(world.tenantRowsWritten() - afterFirst, 0);
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
  assert.deepEqual(event.crewTags, ["crew:work"]);
  assert.equal(world.tenantSql().exec("SELECT turn_id FROM subscription_turns").toArray().length, 1);
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
  assert.equal(world.tenantSql().exec("SELECT * FROM subscription_start_refusals").toArray().length, 1);
  assert.equal(world.tenantRowsWritten() - written, 5);
  await world.passes(1000);
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

test("one refusal reaches 101 valid subscriptions without returning a server error", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "lead the crew", tags: [] });
  const turn = host.takeOffer();
  await host.claims(turn);
  for (let each = 0; each < 101; each++) {
    await world.subscribe(foreman, {
      prompt: "handle refused starts",
      goal: "finish",
      events: ["StartRefused"],
      crewTags: [],
    });
  }
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
  assert.equal(world.tenantSql().exec("SELECT * FROM subscription_start_refusals").toArray().length, 101);
  assert.equal(world.tenantSql().exec("SELECT * FROM subscription_turns").toArray().length, 101);
  assert.equal(world.tenantRowsWritten() - written, 1113);
  const queued = world.tenantSql().exec("SELECT subscription_id FROM subscription_turns").toArray();
  assert.equal(new Set(queued.map((row) => row.subscription_id)).size, 101);
  const repeatedWritten = world.tenantRowsWritten();
  const repeated = await world.fetch(
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
  assert.equal(repeated.status, 422);
  assert.equal(world.tenantRowsWritten() - repeatedWritten, 0);
  await host.finishes(turn);
  for (let each = 0; each < 101; each++) {
    const delivery = host.takeOffer();
    assert.equal(delivery.sessionId, foreman.sessionId);
    assert.equal((delivery.prompt.match(/"event":"StartRefused"/g) ?? []).length, 1);
    await host.claims(delivery);
    await host.finishes(delivery);
  }
  assert.equal(host.holds("TurnOffer"), false);
});
