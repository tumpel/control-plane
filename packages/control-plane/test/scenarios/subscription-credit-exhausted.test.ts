import assert from "node:assert/strict";
import { test } from "node:test";
import { World } from "./harness/world.ts";

const CREDIT_ERROR = "the harness ended the turn with an error: Credit balance is too low";

test("a crew turn that runs out of credit pauses the foreman's subscription and offers the foreman no turn", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");

  const foreman = await world.startSession({ prompt: "plan the epic", tags: ["role:foreman"] });
  const subscription = await world.subscribe(foreman, {
    prompt: "hand out the next step of the epic",
    goal: "the epic is merged",
    events: ["TurnCompleted", "TurnFailed"],
    crewTags: ["crew:epic"],
  });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);

  await world.startSession({ prompt: "build part one", tags: ["crew:epic"] });
  const crewTurn = host.takeOffer();
  await host.claims(crewTurn);
  await host.says({
    type: "TurnFailed",
    turnId: crewTurn.turnId,
    reason: "HarnessReportedError",
    detail: CREDIT_ERROR,
    failedAt: new Date().toISOString(),
  });

  const paused = await world.subscription(subscription.subscriptionId);
  assert.equal(paused.state, "Paused");
  assert.deepEqual(paused.state === "Paused" && paused.reason, { kind: "CreditExhausted", turnId: crewTurn.turnId });
  assert.deepEqual(host.received("TurnOffer"), []);

  await world.startSession({ prompt: "build part two", tags: ["crew:epic"] });
  const laterCrewTurn = host.takeOffer();
  await host.claims(laterCrewTurn);
  await host.finishes(laterCrewTurn);
  assert.deepEqual(host.received("TurnOffer"), [], "crew events wait while the subscription is paused");
});

test("a delivery turn that runs out of credit pauses the subscription instead of queueing the next delivery", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");

  const foreman = await world.startSession({ prompt: "plan the epic", tags: ["role:foreman"] });
  const subscription = await world.subscribe(foreman, {
    prompt: "hand out the next step of the epic",
    goal: "the epic is merged",
    events: ["TurnCompleted"],
    crewTags: ["crew:epic"],
  });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);

  await world.startSession({ prompt: "build part one", tags: ["crew:epic"] });
  const firstCrewTurn = host.takeOffer();
  await host.claims(firstCrewTurn);
  await host.finishes(firstCrewTurn);
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  await host.claims(delivery);

  await world.startSession({ prompt: "build part two", tags: ["crew:epic"] });
  const secondCrewTurn = host.takeOffer();
  await host.claims(secondCrewTurn);
  await host.finishes(secondCrewTurn);

  await host.says({
    type: "TurnFailed",
    turnId: delivery.turnId,
    reason: "HarnessReportedError",
    detail: CREDIT_ERROR,
    failedAt: new Date().toISOString(),
  });

  const paused = await world.subscription(subscription.subscriptionId);
  assert.deepEqual(paused.state === "Paused" && paused.reason, { kind: "CreditExhausted", turnId: delivery.turnId });
  assert.deepEqual(host.received("TurnOffer"), [], "the delivery of the second crew event is not offered");
});

test("after the Owner resumes a subscription paused for credit, the foreman gets the crew failure that waited", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");

  const foreman = await world.startSession({ prompt: "plan the epic", tags: ["role:foreman"] });
  const subscription = await world.subscribe(foreman, {
    prompt: "hand out the next step of the epic",
    goal: "the epic is merged",
    events: ["TurnFailed"],
    crewTags: ["crew:epic"],
  });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);

  const crew = await world.startSession({ prompt: "build part one", tags: ["crew:epic"] });
  const crewTurn = host.takeOffer();
  await host.claims(crewTurn);
  await host.says({
    type: "TurnFailed",
    turnId: crewTurn.turnId,
    reason: "HarnessReportedError",
    detail: CREDIT_ERROR,
    failedAt: new Date().toISOString(),
  });
  assert.equal((await world.subscription(subscription.subscriptionId)).state, "Paused");

  await world.call("resumeSubscription", {
    tenantId: "tenant-scenario",
    subscriptionId: subscription.subscriptionId,
    now: Date.now(),
  });

  assert.equal((await world.subscription(subscription.subscriptionId)).state, "Active");
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.match(delivery.prompt, new RegExp(`"turnId":"${crewTurn.turnId}","sessionId":"${crew.sessionId}"`));
  assert.match(delivery.prompt, /"reason":"CreditExhausted"/);
  assert.deepEqual(host.received("TurnOffer"), []);
});

test("a crew turn that fails with another harness error leaves the subscription active and offers the foreman a delivery", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");

  const foreman = await world.startSession({ prompt: "plan the epic", tags: ["role:foreman"] });
  const subscription = await world.subscribe(foreman, {
    prompt: "hand out the next step of the epic",
    goal: "the epic is merged",
    events: ["TurnFailed"],
    crewTags: ["crew:epic"],
  });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);

  await world.startSession({ prompt: "build part one", tags: ["crew:epic"] });
  const crewTurn = host.takeOffer();
  await host.claims(crewTurn);
  await host.says({
    type: "TurnFailed",
    turnId: crewTurn.turnId,
    reason: "HarnessReportedError",
    detail: "the harness ended the turn with an error: model not found",
    failedAt: new Date().toISOString(),
  });

  const active = await world.subscription(subscription.subscriptionId);
  assert.equal(active.state, "Active");
  assert.equal(active.crewFailuresInARow, 1);
  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.match(delivery.prompt, /"reason":"HarnessReportedError"/);
});
