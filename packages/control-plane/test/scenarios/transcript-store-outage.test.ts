import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS, World } from "./harness/world.ts";

const USAGE = { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000 };

test("a transcript store outage asks for lines again, holds no more than a chunk, backs off, and stores every line once it recovers", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "write a chunk", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  const line = (lineSeq: number) =>
    host.says({ type: "TurnLine", turnId: offer.turnId, lineSeq, text: `{"type":"assistant","n":${lineSeq}}` });
  const put = world.store.put.bind(world.store);
  let tries = 0;
  world.store.put = async () => {
    tries += 1;
    throw new Error("the store is down");
  };

  const chunk = SETTINGS.transcriptChunkLines;
  for (let lineSeq = 1; lineSeq < chunk; lineSeq++) await line(lineSeq);
  await assert.rejects(line(chunk), /TranscriptLinesNotStored/);
  await assert.rejects(line(chunk + 1), /TranscriptLinesNotStored/);
  await assert.rejects(
    world.call("hostUsage", { hostId: host.hostId, usage: USAGE, now: Date.now() }),
    /TranscriptLinesNotStored/,
  );
  assert.equal(tries, 1, "a write inside its backoff does not reach the store");

  world.store.put = put;
  await world.passes(2000);
  for (let lineSeq = chunk; lineSeq <= chunk + 1; lineSeq++) await line(lineSeq);
  await world.call("hostUsage", { hostId: host.hostId, usage: USAGE, now: Date.now() });
  const turn = await world.turn(offer.turnId);
  assert.equal(turn.state, "Running");
  assert.equal(turn.lineCount, chunk + 1);
});
