import assert from "node:assert/strict";
import { test } from "node:test";
import { World } from "./harness/world.ts";

const CREW_FAILURE_LIMIT = 10;

test("a foreman pauses CrewFailing only after the limit of crew failures in a row, and a crew success resets the count", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");

  const foreman = await world.startSession({ prompt: "plan the epic", tags: ["role:foreman"] });
  const subscription = await world.subscribe(foreman, {
    prompt: "hand out the next step of the epic",
    goal: "the epic is merged",
    events: ["SessionFailed"],
    crewTags: ["crew:epic"],
  });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);

  const crew = await world.startSession({ prompt: "build part one", tags: ["crew:epic"] });
  let crewTurn = host.takeOffer();
  assert.equal(crewTurn.sessionId, crew.sessionId);
  const fails = async (): Promise<void> => {
    await host.claims(crewTurn);
    await host.says({
      type: "TurnFailed",
      turnId: crewTurn.turnId,
      reason: "HarnessReportedError",
      detail: "workspace routing discovery timed out",
      failedAt: new Date(Date.now()).toISOString(),
    });
    await host.answersSnapshot(crew.sessionId);
    await world.sendTurn(crew.sessionId, "try again");
    crewTurn = host.takeOffer();
  };
  const read = async (): Promise<[string, number]> => {
    const read = await world.subscription(subscription.subscriptionId);
    return [read.state, read.crewFailuresInARow];
  };

  for (let failure = 1; failure < CREW_FAILURE_LIMIT; failure++) await fails();
  assert.deepEqual(await read(), ["Active", CREW_FAILURE_LIMIT - 1]);

  await host.claims(crewTurn);
  await host.finishes(crewTurn);
  assert.deepEqual(await read(), ["Active", 0]);
  await world.sendTurn(crew.sessionId, "build part two");
  crewTurn = host.takeOffer();

  for (let failure = 1; failure < CREW_FAILURE_LIMIT; failure++) await fails();
  assert.deepEqual(await read(), ["Active", CREW_FAILURE_LIMIT - 1]);
  await fails();
  const paused = await world.subscription(subscription.subscriptionId);
  assert.equal(paused.state, "Paused");
  assert.deepEqual(paused.state === "Paused" && paused.reason, { kind: "CrewFailing" });
  assert.equal(paused.crewFailuresInARow, CREW_FAILURE_LIMIT);
});
