import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import { World } from "./harness/world.ts";

const USAGE = { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000 };

test("a tenant that restarts while it holds transcript lines refuses the checkpoint, and the resent lines land without a gap", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "write three lines", tags: [] });
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
  await world.call("hostHello", {
    hostId: host.hostId,
    boxCapacity: 8,
    usage: USAGE,
    now: Date.now(),
    channelProtocol: ChannelProtocol.Version,
  });
  await world.call("hostUsage", { hostId: host.hostId, usage: USAGE, now: Date.now() });
  const turn = await world.turn(offer.turnId);
  assert.equal(turn.state, "Running");
  const read = await world.transcript(session.sessionId, {});
  assert.deepEqual(
    read.lines.map((stored) => stored.lineSeq),
    [1, 2, 3, 4],
  );
});

test("a tenant that restarts with nothing held asks for the next frame again, and the resent TurnComplete completes the turn", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "answer once", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.says({
    type: "TurnLine",
    turnId: offer.turnId,
    lineSeq: 1,
    text: '{"type":"result","subtype":"success","is_error":false}',
  });
  await world.call("hostUsage", { hostId: host.hostId, usage: USAGE, now: Date.now() });

  world.restartTenant();
  const complete = () =>
    host.says({
      type: "TurnComplete",
      turnId: offer.turnId,
      lastLineSeq: 1,
      completedAt: new Date(Date.now()).toISOString(),
    });
  await assert.rejects(complete(), /TranscriptLinesLost/);
  await complete();
  await host.answersSnapshot(session.sessionId);
  assert.equal((await world.turn(offer.turnId)).state, "Completed");
});
