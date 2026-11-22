import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS, World } from "./harness/world.ts";

const USAGE = { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000 };

test("a turn whose transcript write fails ends as failed, and another turn on the same host is still stored, acked and completed with no row per line", async (t) => {
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

  const lines = SETTINGS.transcriptChunkLines * 2;
  await line(a.turnId, 1);
  await line(b.turnId, 1);
  await heartbeat();
  const failed = await world.turn(a.turnId);
  assert.equal(failed.state, "Failed");
  assert.match(JSON.stringify(failed), /TranscriptNotStored/);
  await host.answersSnapshot(a.sessionId);

  const before = world.tenantRowsWritten();
  for (let lineSeq = 2; lineSeq < lines; lineSeq++) await line(b.turnId, lineSeq);
  await host.says({
    type: "TurnLine",
    turnId: b.turnId,
    lineSeq: lines,
    text: '{"type":"result","subtype":"success","is_error":false}',
  });
  await heartbeat();
  assert.ok(world.tenantRowsWritten() - before < lines / 4, "turn b writes rows per chunk, not per line");
  await host.says({
    type: "TurnComplete",
    turnId: b.turnId,
    lastLineSeq: lines,
    completedAt: new Date().toISOString(),
  });
  await host.answersSnapshot(b.sessionId);
  const completed = await world.turn(b.turnId);
  assert.equal(completed.state, "Completed");
  assert.equal(completed.lineCount, lines);
});
