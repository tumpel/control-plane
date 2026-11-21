import assert from "node:assert/strict";
import { test } from "node:test";
import { World } from "./harness/world.ts";

const USAGE = { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000 };

test("a tenant that restarts while it holds transcript lines refuses the checkpoint, and the resent lines land without a gap", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "write three lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  const line = (lineSeq: number) =>
    host.says({ type: "TurnLine", turnId: offer.turnId, lineSeq, text: `{"type":"assistant","n":${lineSeq}}` });
  for (let lineSeq = 1; lineSeq <= 3; lineSeq++) await line(lineSeq);

  world.restartTenant();
  await assert.rejects(line(4), /TranscriptLinesLost/);
  await assert.rejects(
    world.call("hostUsage", { hostId: host.hostId, usage: USAGE, now: Date.now() }),
    /TranscriptLinesLost/,
  );

  for (let lineSeq = 1; lineSeq <= 4; lineSeq++) await line(lineSeq);
  await world.call("hostUsage", { hostId: host.hostId, usage: USAGE, now: Date.now() });
  const turn = await world.turn(offer.turnId);
  assert.equal(turn.state, "Running");
  assert.equal(turn.lineCount, 4);
});
