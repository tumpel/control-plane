import assert from "node:assert/strict";
import { test } from "node:test";
import { World } from "./harness/world.ts";

test("an idle heartbeat reads rows for live work only, not for every stopped session", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  for (let index = 0; index < 40; index++) {
    const session = await world.startSession({ prompt: `stopped session ${index}`, tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.finishes(offer);
    await host.dropsIdleBox(offer);
    assert.equal((await world.session(session.sessionId)).state, "Stopped");
  }
  await world.subscribe(await world.startSession({ prompt: "subscribed session", tags: [] }), {
    prompt: "watch",
    goal: "watch",
    events: ["TurnCompleted"],
    crewTags: [],
  });
  const live = host.takeOffer();
  await host.claims(live);
  await host.finishes(live);

  const rowsRead = await world.tenantRowsRead(() =>
    world.call("hostUsage", {
      hostId: host.hostId,
      usage: { boxesWarm: 1, loadAverage: 0.1, memoryAvailableMib: 30000 },
      now: Date.now(),
    }),
  );

  assert.ok(rowsRead <= 5, `an idle heartbeat read ${rowsRead} rows`);
});
