import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreateSubscriptionResultSchema,
  PersonaSchema,
  ProblemSchema,
  ResumeSubscriptionResultSchema,
  SubscriptionSchema,
} from "@tumpel/schemas";
import { TENANT_ID, World } from "./harness/world.ts";

test("crew subscription creation refuses a persona without tumpelMcp before writing any rows", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "lead the crew", tags: [] });
  const turn = host.takeOffer();
  await host.claims(turn);
  await host.finishes(turn);
  const response = await world.fetch(world.owner, "GET", `/v1/personas/${foreman.personaId}`);
  assert.equal(response.status, 200);
  const persona = PersonaSchema.parse(await response.json());
  assert.equal(persona.tumpelMcp, false);
  const create = {
    sessionId: foreman.sessionId,
    prompt: "start a crew session per open issue",
    goal: "every open issue has a merged pull request",
    events: ["TurnCompleted"],
    crewTags: ["crew:issues"],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const written = world.tenantRowsWritten();

  const refused = await world.fetch(world.owner, "POST", "/v1/subscriptions", JSON.stringify(create));

  assert.equal(refused.status, 400);
  const problem = ProblemSchema.parse(await refused.json());
  assert.equal(problem.code, "InvalidRequest");
  assert.equal(
    problem.detail,
    `persona ${persona.name} has no tumpelMcp, so it cannot start the crew that crewTags names`,
  );
  assert.equal(
    problem.fix,
    `Set tumpelMcp: true on persona ${persona.name}, or create the subscription without crewTags`,
  );
  assert.equal(world.tenantRowsWritten() - written, 0);
  const directWritten = world.tenantRowsWritten();
  const { created } = CreateSubscriptionResultSchema.parse(
    await world.call("createSubscription", { tenantId: TENANT_ID, subscription: create, now: Date.now() }),
  );
  assert.deepEqual(created, { kind: "PersonaLacksTumpelMcp", personaId: persona.personaId, personaName: persona.name });
  assert.equal(world.tenantRowsWritten() - directWritten, 0);
  const listed = await world.fetch(world.owner, "GET", "/v1/subscriptions");
  assert.equal(listed.status, 200);
  assert.deepEqual(SubscriptionSchema.array().parse(await listed.json()), []);

  const withoutCrewWritten = world.tenantRowsWritten();
  const withoutCrew = await world.fetch(
    world.owner,
    "POST",
    "/v1/subscriptions",
    JSON.stringify({ ...create, crewTags: [] }),
  );
  assert.equal(withoutCrew.status, 200);
  const subscription = SubscriptionSchema.parse(await withoutCrew.json());
  assert.equal(subscription.state, "Active");
  assert.equal(world.tenantRowsWritten() - withoutCrewWritten, 7);

  const path = `/v1/subscriptions/${subscription.subscriptionId}`;
  const paused = await world.fetch(world.owner, "POST", `${path}/pause`, JSON.stringify({ message: "hold" }));
  assert.equal(paused.status, 200);
  const resumeWritten = world.tenantRowsWritten();
  const resumed = await world.fetch(world.owner, "POST", `${path}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal(SubscriptionSchema.parse(await resumed.json()).state, "Active");
  assert.equal(world.tenantRowsWritten() - resumeWritten, 5);

  const patched = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${persona.personaId}`,
    JSON.stringify({ tumpelMcp: true }),
  );
  assert.equal(patched.status, 200);
  const withCrewWritten = world.tenantRowsWritten();
  const withCrew = await world.fetch(world.owner, "POST", "/v1/subscriptions", JSON.stringify(create));
  assert.equal(withCrew.status, 200);
  assert.equal(SubscriptionSchema.parse(await withCrew.json()).state, "Active");
  assert.equal(world.tenantRowsWritten() - withCrewWritten, 9);
});

test("resuming a legacy crew subscription refuses a persona without tumpelMcp without writing rows", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "lead the crew", tags: [] });
  const turn = host.takeOffer();
  await host.claims(turn);
  await host.finishes(turn);
  const response = await world.fetch(world.owner, "GET", `/v1/personas/${foreman.personaId}`);
  assert.equal(response.status, 200);
  const persona = PersonaSchema.parse(await response.json());
  assert.equal(persona.tumpelMcp, false);
  const subscription = await world.subscribe(foreman, {
    prompt: "start a crew session per open issue",
    goal: "every open issue has a merged pull request",
    events: ["TurnCompleted"],
    crewTags: [],
  });
  world
    .tenantSql()
    .exec(
      "INSERT INTO subscription_crew_tags (subscription_id, tag) VALUES (?, ?)",
      subscription.subscriptionId,
      "crew:issues",
    );
  const path = `/v1/subscriptions/${subscription.subscriptionId}`;
  const paused = await world.fetch(world.owner, "POST", `${path}/pause`, JSON.stringify({ message: "hold" }));
  assert.equal(paused.status, 200);
  const before = await world.subscription(subscription.subscriptionId);
  const written = world.tenantRowsWritten();

  const refused = await world.fetch(world.owner, "POST", `${path}/resume`);

  assert.equal(refused.status, 400);
  const problem = ProblemSchema.parse(await refused.json());
  assert.equal(problem.code, "InvalidRequest");
  assert.equal(problem.title, "Persona lacks tumpelMcp");
  assert.equal(
    problem.detail,
    `persona ${persona.name} has no tumpelMcp, so it cannot start the crew that crewTags names`,
  );
  assert.equal(
    problem.fix,
    `Set tumpelMcp: true on persona ${persona.name}, or create the subscription without crewTags`,
  );
  assert.equal(world.tenantRowsWritten() - written, 0);
  const { resumed } = ResumeSubscriptionResultSchema.parse(
    await world.call("resumeSubscription", {
      tenantId: TENANT_ID,
      subscriptionId: subscription.subscriptionId,
      now: Date.now(),
    }),
  );
  assert.deepEqual(resumed, { kind: "PersonaLacksTumpelMcp", personaId: persona.personaId, personaName: persona.name });
  assert.equal(world.tenantRowsWritten() - written, 0);
  assert.deepEqual(await world.subscription(subscription.subscriptionId), before);
});
