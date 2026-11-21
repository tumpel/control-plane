import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS, World } from "./harness/world.ts";

const SECOND = 1000;
const DAY = 24 * 3_600_000;

test("a deadline whose handler always throws is retried 10 times with growing gaps, a new deadline keeps the backoff, and the turn ends Failed", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "fix the build", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  world.db.sql.exec("DELETE FROM hosts WHERE host_id = ?", host.hostId);
  const retries: number[] = [];
  const dropped: string[] = [];
  t.mock.method(console, "error", (line: string) => {
    if (line.startsWith("SessionTimerRetry:")) retries.push(Date.now());
    if (line.startsWith("DeadlineDropped:") || line.startsWith("SessionTimerFailed:")) dropped.push(line);
  });

  await world.passes(SETTINGS.turnTotalBudgetSeconds * SECOND);
  assert.equal(retries.length, 1, "the first try of the Total deadline failed");
  const timer = world.sessionTimer(session.sessionId);
  await timer.timer.set("tenant-scenario", { Snapshot: { turnId: offer.turnId, at: Date.now() + 30 * DAY } });
  assert.ok(((await timer.alarm()) ?? 0) >= Date.now() + SECOND, "a new deadline does not fire the retry at once");

  await world.passes(DAY);
  assert.equal(retries.length, 10);
  const gaps = retries.slice(1).map((at, index) => at - (retries[index] ?? 0));
  for (const [index, gap] of gaps.entries()) {
    if (index > 0) assert.ok(gap >= (gaps[index - 1] ?? 0), `gap ${index + 1} (${gap}) shrank`);
  }
  assert.equal(dropped.length, 1);
  assert.match(dropped[0] ?? "", /^DeadlineDropped: tenant tenant-scenario Total /);

  const turn = await world.turn(offer.turnId);
  assert.equal(turn.state, "Failed");
  assert.equal(turn.state === "Failed" && turn.reason, "TurnTimedOut");
  assert.match(
    turn.state === "Failed" ? turn.detail : "",
    /^the Total deadline failed 11 times, so it was dropped: host \S+ runs a session of tenant tenant-scenario, which does not list it$/,
  );
  assert.equal((await world.session(session.sessionId)).state, "Failed");
});
