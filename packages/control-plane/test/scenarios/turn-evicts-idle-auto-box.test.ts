import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxMemoryLimit } from "@tumpel/schemas";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { type TurnOffer, World } from "./harness/world.ts";

const BOX = BoxMemoryLimit.DefaultMib;

test("a turn to a session with no box, on a host whose memory idle Auto boxes of other sessions hold, tears down the oldest of them and is offered", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "full", { usage: { ...DEFAULT_USAGE, memoryBudgetMib: 3 * BOX } });

  const foreman = await world.startSession({ prompt: "plan the epic", tags: [] });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);
  await host.dropsIdleBox(foremanTurn);
  assert.equal((await world.session(foreman.sessionId)).state, "Stopped");

  const crews: TurnOffer[] = [];
  for (const prompt of ["oldest crew", "middle crew", "newest crew"]) {
    await world.passes(60_000);
    await world.startSession({ prompt, tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.finishes(offer);
    crews.push(offer);
  }
  const [oldest, middle, newest] = crews;
  if (oldest === undefined || middle === undefined || newest === undefined) throw new Error("three crews started");

  const before = world.tenantRowsWritten();
  const sent = await world.sendTurn(foreman.sessionId, "resume the epic");

  assert.deepEqual(host.take("BoxTeardown"), { type: "BoxTeardown", sessionId: oldest.sessionId, boxId: oldest.boxId });
  assert.equal(host.holds("BoxTeardown"), false);
  assert.equal(host.holds("TurnOffer"), false, "the turn waits until the evicted box is gone");
  assert.deepEqual(
    [
      (await world.session(oldest.sessionId)).state,
      (await world.session(middle.sessionId)).state,
      (await world.session(newest.sessionId)).state,
    ],
    ["Stopping", "Idle", "Idle"],
  );

  await host.dropsIdleBox(oldest);
  assert.equal((await world.session(oldest.sessionId)).state, "Stopped");
  const resumed = host.takeOffer();
  assert.deepEqual([resumed.turnId, resumed.sessionId], [sent.turnId, foreman.sessionId]);
  assert.notEqual(resumed.boxId, foremanTurn.boxId);
  const written = world.tenantRowsWritten() - before;
  assert.ok(written <= 22, `the send, the eviction and the offer wrote ${written} tenant rows, over the bound of 22`);
});

test("a Stopping box the host drops without a BoxGone becomes Stopped on its next heartbeat, and the turn waiting for its room is offered", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "full", { usage: { ...DEFAULT_USAGE, memoryBudgetMib: 3 * BOX } });

  const foreman = await world.startSession({ prompt: "plan the epic", tags: [] });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);
  await host.dropsIdleBox(foremanTurn);

  const crews: TurnOffer[] = [];
  for (const prompt of ["oldest crew", "middle crew", "newest crew"]) {
    await world.passes(60_000);
    await world.startSession({ prompt, tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.finishes(offer);
    crews.push(offer);
  }
  const [oldest] = crews;
  if (oldest === undefined) throw new Error("three crews started");

  const sent = await world.sendTurn(foreman.sessionId, "resume the epic");
  assert.deepEqual(host.take("BoxTeardown"), { type: "BoxTeardown", sessionId: oldest.sessionId, boxId: oldest.boxId });
  assert.equal((await world.session(oldest.sessionId)).state, "Stopping");

  await host.beats({ heldSessionIds: host.holding().heldSessionIds.filter((id) => id !== oldest.sessionId) });

  assert.equal((await world.session(oldest.sessionId)).state, "Stopped");
  assert.equal(host.takeOffer().turnId, sent.turnId);
});

test("a turn handed over from an updating host reaches the other host once, whatever that host's heartbeats", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const updating = await world.online(world.owner, "updating");

  await world.startSession({ prompt: "build part one", tags: [] });
  const offer = updating.takeOffer();
  await updating.claims(offer);
  const other = await world.online(world.owner, "other");
  await updating.says({
    type: "TurnFailed",
    turnId: offer.turnId,
    reason: "HostUpdating",
    detail: "the supervisor is updating",
    failedAt: new Date().toISOString(),
  });

  await other.beats();
  await other.beats();

  const offers = other.received("TurnOffer");
  assert.deepEqual(
    offers.map((each) => (each.type === "TurnOffer" ? each.turnId : null)),
    [offer.turnId],
  );
});
