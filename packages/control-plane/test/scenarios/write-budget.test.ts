import assert from "node:assert/strict";
import { test } from "node:test";
import { World } from "./harness/world.ts";

const STEADY_ROWS_BUDGET = 100;
const TURN_ROWS_BUDGET = 53;

const SESSIONS = 10;
const LINE_EVERY_MS = 2_000;
const HEARTBEAT_EVERY_MS = 10_000;
const STREAM_MS = 10 * 60_000;

test("one host streaming 10 running turns for 10 minutes writes fewer than 100 tenant rows", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", { boxCapacity: SESSIONS });
  const turnIds: string[] = [];
  for (let session = 1; session <= SESSIONS; session++) {
    await world.startSession({ prompt: `stream session ${session}`, tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.says({
      type: "TurnLines",
      turnId: offer.turnId,
      firstLineSeq: 1,
      lines: ['{"type":"assistant","n":1}'],
    });
    turnIds.push(offer.turnId);
  }
  await host.beats();

  const start = world.tenantRowsWritten();
  let lineSeq = 1;
  for (let elapsed = LINE_EVERY_MS; elapsed <= STREAM_MS; elapsed += LINE_EVERY_MS) {
    await world.passes(LINE_EVERY_MS);
    lineSeq += 1;
    for (const turnId of turnIds) {
      await host.says({
        type: "TurnLines",
        turnId,
        firstLineSeq: lineSeq,
        lines: [`{"type":"assistant","n":${lineSeq}}`],
      });
    }
    if (elapsed % HEARTBEAT_EVERY_MS === 0) {
      await host.beats();
    }
  }
  const rows = world.tenantRowsWritten() - start;

  for (const turnId of turnIds) assert.equal((await world.turn(turnId)).state, "Running");
  assert.ok(rows < STEADY_ROWS_BUDGET, `10 running turns wrote ${rows} tenant rows in 10 minutes`);
});

test("one turn from offer to completion writes a fixed number of tenant rows", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const start = world.tenantRowsWritten();
  const session = await world.startSession({ prompt: "answer in a few lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  for (let lineSeq = 1; lineSeq <= 10; lineSeq++) {
    await host.says({
      type: "TurnLines",
      turnId: offer.turnId,
      firstLineSeq: lineSeq,
      lines: [`{"type":"assistant","n":${lineSeq}}`],
    });
  }
  await host.beats();
  await host.says({
    type: "TurnLines",
    turnId: offer.turnId,
    firstLineSeq: 11,
    lines: ['{"type":"result","subtype":"success","is_error":false}'],
  });
  await host.says({
    type: "TurnComplete",
    turnId: offer.turnId,
    lastLineSeq: 11,
    completedAt: new Date().toISOString(),
  });
  await world.passes(30_000);
  await host.answersSnapshot(session.sessionId);
  const rows = world.tenantRowsWritten() - start;

  const turn = await world.turn(offer.turnId);
  assert.equal(turn.state, "Completed");
  assert.equal(turn.lineCount, 11);
  assert.ok(rows <= TURN_ROWS_BUDGET, `one turn wrote ${rows} tenant rows`);
});
