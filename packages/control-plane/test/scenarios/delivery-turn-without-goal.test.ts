import assert from "node:assert/strict";
import { test } from "node:test";
import { World } from "./harness/world.ts";

test("a delivery turn carries the subscription goal as context and ends when the foreman stops, with no goal hook to keep it alive", async (t) => {
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
  const crewTurn = host.takeOffer();
  await host.claims(crewTurn);
  await host.finishes(crewTurn);

  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.doesNotMatch(delivery.prompt, /^\/goal/, "the harness gets no goal command");
  assert.match(delivery.prompt, /^hand out the next step of the epic\n\n/);
  assert.match(
    delivery.prompt,
    /\n\nSubscription goal: the epic is merged\nCall tumpel_subscription_complete when the goal holds\./,
  );
  assert.equal((await world.turn(delivery.turnId)).goal, undefined);

  await host.claims(delivery);
  await host.finishes(delivery);
  assert.equal((await world.turn(delivery.turnId)).state, "Completed");
  assert.equal((await world.session(foreman.sessionId)).state, "Idle");
  assert.equal((await world.subscription(subscription.subscriptionId)).state, "Active");
});
