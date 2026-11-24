import assert from "node:assert/strict";
import { test } from "node:test";
import { ListEventsResultSchema, PersonaSchema, ProblemSchema, ServeConnectorTokenResultSchema } from "@tumpel/schemas";
import { RELEASE_CACHE_MS } from "../../src/releases.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "../release-fixture.ts";
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
  assert.equal(world.tenantRowsWritten() - before, 3);
  const afterFirst = world.tenantRowsWritten();
  const repeated = await world.fetch(member, "POST", "/v1/sessions", JSON.stringify(body));
  assert.equal(repeated.status, 409);
  assert.deepEqual(ProblemSchema.parse(await repeated.json()), problem);
  assert.equal(world.tenantRowsWritten() - afterFirst, 3);
  const readback = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=StartRefused");
  assert.equal(readback.status, 200);
  const { events } = await readback.json();
  assert.equal(events.length, 2);
  const event = events[0];
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
  assert.deepEqual(
    delivery.prompt
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line)),
    [events[1]],
  );
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal(host.holds("TurnOffer"), false);
});

test("StartRefused records a refused start from a resolved issue", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", {
    boxCapacity: 1,
    usage: { ...DEFAULT_USAGE, memoryBudgetMib: 2048, memoryAvailableMib: 2048 },
  });
  const filler = await world.startSession({ prompt: "hold the only box", tags: [] });
  await host.claims(host.takeOffer());
  const response = await world.fetch(world.owner, "GET", `/v1/personas/${filler.personaId}`);
  assert.equal(response.status, 200);
  const persona = PersonaSchema.parse(await response.json());
  await world.call("setSecretMember", {
    tenantId: TENANT_ID,
    secretSetId: persona.secretSetId,
    member: { kind: "Variable", name: "GITHUB_TOKEN", value: "ghp-e2e-scenario" },
    githubUser: { githubUserId: 1, login: "scenario" },
    now: Date.now(),
  });
  const before = world.tenantRowsWritten();
  const refused = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions/from-issue",
    JSON.stringify({
      personaId: filler.personaId,
      owner: "acme",
      name: "app",
      issueNumber: 12,
      model: "opus",
      tags: ["crew:work"],
    }),
  );
  assert.equal(refused.status, 409);
  const problem = ProblemSchema.parse(await refused.json());
  assert.equal(problem.code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - before, 3);
  const read = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=StartRefused");
  assert.equal(read.status, 200);
  const { events } = await read.json();
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, "Start");
  assert.equal(events[0].personaId, filler.personaId);
  assert.equal(events[0].caller.kind, "Person");
  assert.deepEqual(events[0].crewTags, ["crew:work"]);
  assert.deepEqual(events[0].refusal, { code: problem.code, detail: problem.detail });
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
  await world.call("pin", { pin: { harness: "ClaudeCode", harnessVersion: "removed-version" }, now: Date.now() });
  const resized = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${target.personaId}`,
    JSON.stringify({ boxMemoryMib: 4096 }),
  );
  assert.equal(resized.status, 200);
  const before = world.tenantRowsWritten();
  const response = await world.fetch(member, "POST", `/v1/sessions/${target.sessionId}/turns`, JSON.stringify(body));
  assert.equal(response.status, 409);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - before, 3);
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
  assert.equal(world.tenantSql().exec("SELECT box_memory_mib FROM room_refusals").one().box_memory_mib, 2048);
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

test("a stopping subscriber leaves the refusal delivery slot available for a runnable subscriber", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const first = await world.startSession({ prompt: "first foreman", tags: [], boxRetention: "Warm" });
  const firstTurn = host.takeOffer();
  await host.claims(firstTurn);
  await host.finishes(firstTurn);
  const second = await world.startSession({ prompt: "second foreman", tags: [], boxRetention: "Warm" });
  const secondTurn = host.takeOffer();
  await host.claims(secondTurn);
  await host.finishes(secondTurn);
  const events = { prompt: "handle refusals", goal: "finish", events: ["StartRefused"], crewTags: [] };
  const left = await world.subscribe(first, events);
  const right = await world.subscribe(second, events);
  const [stopping, runnable] = left.subscriptionId < right.subscriptionId ? [left, right] : [right, left];
  await world.call("stopSession", {
    tenantId: TENANT_ID,
    sessionId: stopping.sessionId,
    cancelledBy: null,
    now: Date.now(),
  });
  assert.equal((await world.session(stopping.sessionId)).state, "Stopping");
  const response = await world.fetch(
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
  assert.equal(response.status, 422);
  const offer = host.takeOffer();
  assert.equal(offer.sessionId, runnable.sessionId);
  assert.match(offer.prompt, /StartRefused/);
  assert.equal((await world.subscription(stopping.subscriptionId)).cursorEventId, stopping.cursorEventId);
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
  const refusal = world
    .tenantSql()
    .exec("SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'StartRefused'")
    .one();
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
  const delivered = world.tenantSql().exec("SELECT start_refusal_event_id FROM subscriptions").toArray();
  assert.equal(delivered.length, 101);
  assert.deepEqual([...new Set(delivered.map((row) => row.start_refusal_event_id))], [refusal.event_id]);
});

test("a catalog preflight refusal records the code and detail the caller received", async (t) => {
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

test("refusal appends stay bounded while maintenance drains expired events in batches", async (t) => {
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
  await host.closesSocket();
  for (const remaining of [101, 69, 37, 5, 0]) {
    const before = world.tenantRowsWritten();
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
    const expired = world
      .tenantSql()
      .exec("SELECT COUNT(*) AS count FROM events WHERE created_at < ?", Date.now() - 7 * 24 * 60 * 60 * 1000)
      .one();
    assert.equal(expired.count, remaining);
    assert.ok(world.tenantRowsWritten() - before <= 36);
  }
});

for (const [index, release] of ["missing-image", "unpublished"].entries()) {
  test(`start and send record ImageNotReleased when the release is ${release}`, async (t) => {
    const world = await World.open({ start: Date.parse("2026-11-21T12:00:00Z") + index * 2 * RELEASE_CACHE_MS });
    t.after(() => world.close());
    const host = await world.hostOnline("host-1");
    const session = await world.startSession({ prompt: "work before an image goes away", tags: [] });
    const turn = host.takeOffer();
    await host.claims(turn);
    await host.finishes(turn);
    await host.dropsIdleBox(turn);
    if (release === "unpublished") await world.releases.delete("current.json");
    else
      await world.releases.put(
        "current.json",
        JSON.stringify({
          ...CLAUDE_CODE_AMD64_RELEASE,
          images: [],
          harnessLayers: CLAUDE_CODE_AMD64_RELEASE.harnessLayers.map((layer) => ({
            ...layer,
            harnessVersion: "0.0.0",
          })),
        }),
      );
    await world.tick(RELEASE_CACHE_MS);
    const before = world.tenantRowsWritten();
    const start = await world.fetch(
      world.owner,
      "POST",
      "/v1/sessions",
      JSON.stringify({
        personaId: session.personaId,
        repository: "https://github.com/acme/app",
        model: "opus",
        prompt: "start again",
      }),
    );
    const send = await world.fetch(
      world.owner,
      "POST",
      `/v1/sessions/${session.sessionId}/turns`,
      JSON.stringify({ prompt: "send again" }),
    );
    assert.equal(start.status, 422);
    assert.equal(send.status, 422);
    const startProblem = ProblemSchema.parse(await start.json());
    const sendProblem = ProblemSchema.parse(await send.json());
    assert.equal(startProblem.code, "ImageNotReleased");
    assert.equal(sendProblem.code, "ImageNotReleased");
    const detail =
      release === "unpublished"
        ? /no guest image release has been published/
        : /the current release has no ClaudeCode .* guest image/;
    assert.match(startProblem.detail, detail);
    assert.match(sendProblem.detail, detail);
    assert.equal(world.tenantRowsWritten() - before, 4);
    const read = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=StartRefused");
    assert.equal(read.status, 200);
    const { events } = await read.json();
    assert.deepEqual(
      events.map(({ operation, refusal }: { operation: string; refusal: object }) => ({ operation, refusal })),
      [
        { operation: "Start", refusal: { code: startProblem.code, detail: startProblem.detail } },
        { operation: "Send", refusal: { code: sendProblem.code, detail: sendProblem.detail } },
      ],
    );
    assert.equal(world.tenantSql().exec("SELECT COUNT(*) AS count FROM room_refusals").one().count, 0);
  });
}
