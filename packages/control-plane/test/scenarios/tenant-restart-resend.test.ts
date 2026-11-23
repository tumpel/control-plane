import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDGETS, World } from "./harness/world.ts";

const USAGE = { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000, ...BUDGETS };

test("a tenant that restarts while it holds transcript lines takes them again from the host channel, and they land without a gap", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "write three lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  const line = (lineSeq: number) =>
    host.says({
      type: "TurnLines",
      turnId: offer.turnId,
      firstLineSeq: lineSeq,
      lines: [`{"type":"assistant","n":${lineSeq}}`],
    });
  for (let lineSeq = 1; lineSeq <= 3; lineSeq++) await line(lineSeq);

  await world.restartTenant();
  await line(4);
  host.report(USAGE);
  await world.settle();

  assert.equal(host.closure(), null);
  const turn = await world.turn(offer.turnId);
  assert.equal(turn.state, "Running");
  const read = await world.transcript(session.sessionId, {});
  assert.deepEqual(
    read.lines.map((stored) => stored.lineSeq),
    [1, 2, 3, 4],
  );
});

test("a tenant that restarts with nothing held takes the next frame again from the host channel, and the resent TurnComplete completes the turn", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "answer once", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.says({
    type: "TurnLines",
    turnId: offer.turnId,
    firstLineSeq: 1,
    lines: ['{"type":"result","subtype":"success","is_error":false}'],
  });
  host.report(USAGE);
  await world.settle();

  await world.restartTenant();
  await host.says({
    type: "TurnComplete",
    turnId: offer.turnId,
    lastLineSeq: 1,
    completedAt: new Date(Date.now()).toISOString(),
  });
  host.report(USAGE);
  await world.until(
    "a SnapshotRequest after the restart",
    () => host.received("SnapshotRequest").length,
    (requests) => requests > 0,
  );
  await host.answersSnapshot(session.sessionId);
  assert.equal((await world.turn(offer.turnId)).state, "Completed");
});
