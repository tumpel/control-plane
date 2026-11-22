import assert from "node:assert/strict";
import { test } from "node:test";
import { World } from "./harness/world.ts";

test("a foreman whose idle box the host dropped gets the next crew event as a turn on a fresh box", async (t) => {
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
  assert.equal((await world.session(foreman.sessionId)).state, "Idle");

  const crew = await world.startSession({ prompt: "build part one", tags: ["crew:epic"] });
  const crewTurn = host.takeOffer();
  assert.equal(crewTurn.sessionId, crew.sessionId);
  await host.claims(crewTurn);

  assert.equal(foremanTurn.idleSeconds, 15 * 60);
  await world.passes(foremanTurn.idleSeconds * 1000);
  await host.dropsIdleBox(foremanTurn);
  assert.equal((await world.session(foreman.sessionId)).state, "Stopped");

  await host.finishes(crewTurn);

  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.notEqual(delivery.boxId, foremanTurn.boxId, "the delivery runs on a fresh box");
  assert.match(delivery.prompt, new RegExp(`"sessionId":"${crew.sessionId}"`));
  await host.claims(delivery);
  await host.finishes(delivery);
  assert.ok((await world.subscription(subscription.subscriptionId)).cursorEventId > subscription.cursorEventId);
});
