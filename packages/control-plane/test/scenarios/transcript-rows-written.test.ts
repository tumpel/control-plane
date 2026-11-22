import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS, World } from "./harness/world.ts";

const RESULT = '{"type":"result","subtype":"success","is_error":false}';

const rowsFor = async (lines: number) => {
  const world = await World.open();
  try {
    const host = await world.hostOnline("host-1");
    const session = await world.startSession({ prompt: "write a long answer", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    const start = world.tenantRowsWritten();
    for (let lineSeq = 1; lineSeq <= lines; lineSeq++) {
      await host.says({ type: "TurnLine", turnId: offer.turnId, lineSeq, text: `{"type":"assistant","n":${lineSeq}}` });
    }
    const streamed = world.tenantRowsWritten() - start;
    await host.says({ type: "TurnLine", turnId: offer.turnId, lineSeq: lines + 1, text: RESULT });
    await host.says({
      type: "TurnComplete",
      turnId: offer.turnId,
      lastLineSeq: lines + 1,
      completedAt: new Date(Date.now()).toISOString(),
    });
    await host.answersSnapshot(session.sessionId);
    const turn = await world.turn(offer.turnId);
    assert.equal(turn.lineCount, lines + 1);
    return { streamed, turn: world.tenantRowsWritten() - start };
  } finally {
    world.close();
  }
};

test("transcript lines within a chunk write no row each, so a turn's rows do not grow with its lines", async () => {
  const short = await rowsFor(2);
  const long = await rowsFor(SETTINGS.transcriptChunkLines - 2);
  assert.equal(long.streamed, short.streamed);
  assert.equal(long.turn, short.turn);
});

test("a long transcript writes no row per chunk of lines, so a turn's rows do not grow with its chunks", async () => {
  const short = await rowsFor(SETTINGS.transcriptChunkLines);
  const long = await rowsFor(SETTINGS.transcriptChunkLines * 10);
  assert.equal(long.streamed, short.streamed);
  assert.equal(long.turn, short.turn);
});
