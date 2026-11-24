import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxMemoryLimit } from "@tumpel/schemas";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { World } from "./harness/world.ts";

const BOX = BoxMemoryLimit.DefaultMib;

test("a turn that evicts the only idle box of a host whose disk budget is under one box disk is offered once the host reports the box gone", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "small", { usage: { ...DEFAULT_USAGE, diskBudgetMib: 20_000 } });

  const foreman = await world.startSession({ prompt: "plan the epic", tags: [] });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);
  await host.dropsIdleBox(foremanTurn);

  await world.startSession({ prompt: "review the plan", tags: [] });
  const reviewer = host.takeOffer();
  await host.claims(reviewer);
  await host.finishes(reviewer);
  host.report({ memoryHeldMib: BOX, diskHeldMib: 8192 });

  const sent = await world.sendTurn(foreman.sessionId, "resume the epic");
  assert.deepEqual(host.take("BoxTeardown"), {
    type: "BoxTeardown",
    sessionId: reviewer.sessionId,
    boxId: reviewer.boxId,
  });

  await host.dropsIdleBox(reviewer);
  assert.equal((await world.session(reviewer.sessionId)).state, "Stopped");
  assert.equal((await world.turn(sent.turnId)).state, "Offered");
  assert.equal(host.holds("TurnOffer"), false, "the host has not yet reported the evicted box's disk free");

  host.report({ memoryHeldMib: 0, diskHeldMib: 0 });
  await host.beats();

  const resumed = host.takeOffer();
  assert.deepEqual([resumed.turnId, resumed.sessionId], [sent.turnId, foreman.sessionId]);
});

test("a turn that evicts the only idle box of a host still short of disk once the box is gone fails, naming the disk", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "small", { usage: { ...DEFAULT_USAGE, diskBudgetMib: 20_000 } });

  const foreman = await world.startSession({ prompt: "plan the epic", tags: [] });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);
  await host.dropsIdleBox(foremanTurn);

  await world.startSession({ prompt: "review the plan", tags: [] });
  const reviewer = host.takeOffer();
  await host.claims(reviewer);
  await host.finishes(reviewer);
  host.report({ memoryHeldMib: BOX, diskHeldMib: 8192 });

  const sent = await world.sendTurn(foreman.sessionId, "resume the epic");
  host.take("BoxTeardown");
  await host.dropsIdleBox(reviewer);

  host.report({ memoryHeldMib: 0, diskHeldMib: 8192 });
  await host.beats();

  const failed = await world.turn(sent.turnId);
  assert.equal(failed.state, "Failed");
  assert.equal(host.holds("TurnOffer"), false);
  assert.equal(
    "detail" in failed ? failed.detail : null,
    "the idle boxes stopped to make room for this turn left host small short of disk: it gives boxes 20000 MiB of disk and its other boxes hold 8192 MiB of it, so this turn's box disk of 32768 MiB does not fit; send the turn again",
  );
});
