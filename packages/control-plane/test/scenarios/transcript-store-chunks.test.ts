import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDGETS, type Host, SETTINGS, World } from "./harness/world.ts";

const RESULT = '{"type":"result","subtype":"success","is_error":false}';
const USAGE = { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000, ...BUDGETS };

const line = (host: Host, turnId: string, lineSeq: number) =>
  host.says({ type: "TurnLines", turnId, firstLineSeq: lineSeq, lines: [`{"type":"assistant","n":${lineSeq}}`] });

const completes = async (host: Host, sessionId: string, turnId: string, lastLineSeq: number) => {
  await host.says({ type: "TurnLines", turnId, firstLineSeq: lastLineSeq, lines: [RESULT] });
  await host.says({ type: "TurnComplete", turnId, lastLineSeq, completedAt: new Date().toISOString() });
  await host.answersSnapshot(sessionId);
};

const readAll = async (world: World, sessionId: string, turnId?: string) => {
  const seqs: number[] = [];
  for (let after = 0; ; ) {
    const page = await world.transcript(sessionId, { after, ...(turnId === undefined ? {} : { turnId }) });
    seqs.push(...page.lines.map((read) => read.lineSeq));
    if (page.finished) return seqs;
    assert.ok(page.cursor > after, `a read after ${after} moved no further`);
    after = page.cursor;
  }
};

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, at) => from + at);

test("a tenant that restarts after storing a chunk goes on from the stored lines, and every turn reads back from the store in order", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "write a long answer", tags: [] });
  const first = host.takeOffer();
  await host.claims(first);
  const stored = SETTINGS.transcriptChunkLines;
  for (let lineSeq = 1; lineSeq <= stored + 6; lineSeq++) await line(host, first.turnId, lineSeq);

  await world.restartTenant();
  await line(host, first.turnId, stored + 7);
  host.report(USAGE);
  await world.settle();
  await host.says({ type: "TurnLines", turnId: first.turnId, firstLineSeq: stored + 8, lines: [RESULT] });
  await host.says({
    type: "TurnComplete",
    turnId: first.turnId,
    lastLineSeq: stored + 8,
    completedAt: new Date().toISOString(),
  });
  await world.until(
    "a SnapshotRequest for the turn the restarted tenant completed",
    () => host.received("SnapshotRequest").length,
    (requests) => requests > 0,
  );
  await host.answersSnapshot(session.sessionId);
  assert.equal((await world.turn(first.turnId)).lineCount, stored + 8);

  await world.passes(1_000);
  await world.sendTurn(session.sessionId, "and a short one");
  const second = host.takeOffer();
  await host.claims(second);
  for (let lineSeq = stored + 9; lineSeq <= stored + 11; lineSeq++) await line(host, second.turnId, lineSeq);
  host.report(USAGE);
  await world.settle();
  await completes(host, session.sessionId, second.turnId, stored + 12);

  assert.equal((await world.turn(second.turnId)).lineCount, 4);
  assert.deepEqual(await readAll(world, session.sessionId), range(1, stored + 12));
  assert.deepEqual(await readAll(world, session.sessionId, first.turnId), range(1, stored + 8));
  assert.deepEqual(await readAll(world, session.sessionId, second.turnId), range(stored + 9, stored + 12));
});
