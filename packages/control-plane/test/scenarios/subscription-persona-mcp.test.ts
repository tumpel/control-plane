import assert from "node:assert/strict";
import { test } from "node:test";
import { PersonaSchema, ProblemSchema, SubscriptionSchema } from "@tumpel/schemas";
import { World } from "./harness/world.ts";

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
    `session ${foreman.sessionId} runs persona ${persona.name}, which has no tumpelMcp, so it cannot start the crew that crewTags names`,
  );
  assert.equal(
    problem.fix,
    `Set tumpelMcp: true on persona ${persona.name}, or create the subscription without crewTags`,
  );
  assert.equal(world.tenantRowsWritten() - written, 0);
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
  assert.equal(SubscriptionSchema.parse(await withoutCrew.json()).state, "Active");
  assert.equal(world.tenantRowsWritten() - withoutCrewWritten, 3);

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
  assert.equal(world.tenantRowsWritten() - withCrewWritten, 4);
});
