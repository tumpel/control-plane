import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS, World } from "./harness/world.ts";

const USAGE = { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000 };

const pendingLines = (world: World, turnId: string): number =>
  Number(
    world.tenantSql().exec("SELECT COUNT(*) AS lines FROM transcript_pending WHERE turn_id = ?", turnId).one().lines,
  );

test("a transcript store outage keeps the lines in tenant storage, tries the store on every heartbeat, and moves them to the store once it recovers", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "write a chunk", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  const line = (lineSeq: number) =>
    host.says({ type: "TurnLine", turnId: offer.turnId, lineSeq, text: `{"type":"assistant","n":${lineSeq}}` });
  const heartbeat = () => world.call("hostUsage", { hostId: host.hostId, usage: USAGE, now: Date.now() });
  const put = world.store.put.bind(world.store);
  let tries = 0;
  world.store.put = async () => {
    tries += 1;
    throw new Error("the store is down");
  };

  const chunk = SETTINGS.transcriptChunkLines;
  for (let lineSeq = 1; lineSeq <= chunk + 1; lineSeq++) await line(lineSeq);
  await heartbeat();
  await heartbeat();
  assert.equal(tries, 3, "the full chunk and each heartbeat try the store");
  assert.equal(pendingLines(world, offer.turnId), chunk + 1);
  assert.equal((await world.turn(offer.turnId)).lineCount, chunk + 1);

  world.store.put = put;
  await line(chunk + 2);
  await heartbeat();
  const turn = await world.turn(offer.turnId);
  assert.equal(turn.state, "Running");
  assert.equal(turn.lineCount, chunk + 2);
  assert.equal(pendingLines(world, offer.turnId), 0);
});

test("a turn whose transcript writes fail does not hold up another turn on the same host", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "turn a", tags: [] });
  const a = host.takeOffer();
  await host.claims(a);
  await world.startSession({ prompt: "turn b", tags: [] });
  const b = host.takeOffer();
  await host.claims(b);
  const line = (turnId: string, lineSeq: number) =>
    host.says({ type: "TurnLine", turnId, lineSeq, text: `{"type":"assistant","n":${lineSeq}}` });
  const heartbeat = () => world.call("hostUsage", { hostId: host.hostId, usage: USAGE, now: Date.now() });
  const put = world.store.put.bind(world.store);
  world.store.put = (async (key: string, ...rest: unknown[]) => {
    if (key.includes(a.turnId)) throw new Error("the store refuses turn a");
    return (put as (key: string, ...rest: unknown[]) => Promise<unknown>)(key, ...rest);
  }) as typeof world.store.put;

  for (let lineSeq = 1; lineSeq <= 3; lineSeq++) {
    await line(a.turnId, lineSeq);
    await line(b.turnId, lineSeq);
    await heartbeat();
    assert.equal((await world.turn(b.turnId)).lineCount, lineSeq);
    assert.equal(pendingLines(world, b.turnId), 0);
  }
  assert.equal(pendingLines(world, a.turnId), 3);
  assert.equal((await world.turn(a.turnId)).lineCount, 3);
});
