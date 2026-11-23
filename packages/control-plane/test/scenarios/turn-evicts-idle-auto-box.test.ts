import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxMemoryLimit, ProblemSchema } from "@tumpel/schemas";
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
});

test("a turn to a session with no box, on a host whose memory only idle Warm boxes hold, is refused PoolExhausted and tears nothing down", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "full", { usage: { ...DEFAULT_USAGE, memoryBudgetMib: 3 * BOX } });

  const foreman = await world.startSession({ prompt: "plan the epic", tags: [] });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);
  await host.dropsIdleBox(foremanTurn);

  for (const prompt of ["first warm crew", "second warm crew", "third warm crew"]) {
    await world.passes(60_000);
    await world.startSession({ prompt, tags: [], boxRetention: "Warm" });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.finishes(offer);
  }

  const refused = await world.fetch(
    world.owner,
    "POST",
    `/v1/sessions/${foreman.sessionId}/turns`,
    JSON.stringify({ prompt: "resume the epic" }),
  );

  assert.equal(refused.status, 409);
  const problem = ProblemSchema.parse(await refused.json());
  assert.deepEqual(
    [problem.code, problem.title, problem.detail],
    [
      "PoolExhausted",
      "Every host's box memory is in use",
      `no host of your tenant has memory for another box: full gives boxes ${3 * BOX} MiB of memory and its boxes hold ${3 * BOX} MiB of it, and the persona's boxes need ${BOX} MiB`,
    ],
  );
  assert.equal(host.holds("BoxTeardown"), false);
  assert.equal(host.holds("TurnOffer"), false);
});
