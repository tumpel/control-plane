import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS, TENANT_ID, World } from "./harness/world.ts";

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
    if (line.startsWith("SessionTimerRetry:") && line.includes(" for Total ")) retries.push(Date.now());
    if (/^(DeadlineDropped|SessionTimerFailed):.* Total[: ]/.test(line)) dropped.push(line);
  });

  await world.passes(SETTINGS.turnTotalBudgetSeconds * SECOND);
  assert.equal(retries.length, 1, "the first try of the Total deadline failed");
  const timer = world.sessionTimer(session.sessionId);
  await timer.timer.set(TENANT_ID, { Snapshot: { turnId: offer.turnId, at: Date.now() + 30 * DAY } });
  assert.ok(((await timer.alarm()) ?? 0) >= Date.now() + SECOND, "a new deadline does not fire the retry at once");

  await world.passes(DAY);
  assert.equal(retries.length, 10);
  const gaps = retries.slice(1).map((at, index) => at - (retries[index] ?? 0));
  for (const [index, gap] of gaps.entries()) {
    if (index > 0) assert.ok(gap >= (gaps[index - 1] ?? 0), `gap ${index + 1} (${gap}) shrank`);
  }
  assert.equal(dropped.length, 1);
  assert.match(dropped[0] ?? "", new RegExp(`^DeadlineDropped: tenant ${TENANT_ID} ${session.sessionId} Total: `));

  const turn = await world.turn(offer.turnId);
  assert.equal(turn.state, "Failed");
  assert.equal(turn.state === "Failed" && turn.reason, "TurnTimedOut");
  assert.match(
    turn.state === "Failed" ? turn.detail : "",
    /^the Total deadline failed 11 times, so it was dropped: host \S+ runs a session of tenant tenant-scenario, which does not list it$/,
  );
  assert.equal((await world.session(session.sessionId)).state, "Idle");
});

test("stale deadlines dropped during a D1 outage fail nothing while the turn is healthy", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const running: { sessionId: string; turnId: string }[] = [];
  for (const prompt of ["fix the build", "fix the docs"]) {
    const session = await world.startSession({ prompt, tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.says({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: '{"type":"system"}' });
    running.push({ sessionId: session.sessionId, turnId: offer.turnId });
  }
  world.db.sql.exec("DELETE FROM hosts WHERE host_id = ?", host.hostId);
  const dropped: string[] = [];
  t.mock.method(console, "error", (line: string) => {
    if (line.startsWith("DeadlineDropped:")) dropped.push(line);
  });

  const [first, second] = running;
  assert.ok(first !== undefined && second !== undefined);
  await world
    .sessionTimer(first.sessionId)
    .timer.set(TENANT_ID, { FirstLine: { turnId: first.turnId, at: Date.now() } });
  await world.sessionTimer(second.sessionId).timer.set(TENANT_ID, {
    HostOffline: { turnId: second.turnId, at: Date.now() },
  });
  await world.passes(SETTINGS.turnTotalBudgetSeconds * SECOND - 10 * SECOND);

  assert.deepEqual(
    dropped.map((line) => line.split(":")[1]?.split(" ").at(-1)).sort(),
    ["FirstLine", "HostOffline"],
    "both stale deadlines were dropped",
  );
  for (const { sessionId, turnId } of running) {
    assert.equal((await world.turn(turnId)).state, "Running");
    assert.equal((await world.session(sessionId)).state, "Running");
  }
});

test("deadlines the timer could not deliver to an unreachable tenant are reached on the tenant's next call", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "fix the build", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  const failed: string[] = [];
  t.mock.method(console, "error", (line: string) => {
    if (line.startsWith("SessionTimerFailed:")) failed.push(line);
  });
  const unreachable = t.mock.method(world.tenantOperations(), "deadlineReached", async () => {
    throw new Error("the tenant Durable Object is unreachable");
  });

  await world.passes(SETTINGS.turnTotalBudgetSeconds * SECOND + DAY);
  assert.equal(unreachable.mock.callCount(), 11, "the first try and 10 retries");
  assert.equal(failed.length, 1);
  assert.match(failed[0] ?? "", /^SessionTimerFailed: tenant tenant-scenario stopped retrying the deadlines Total /);
  assert.equal((await world.turn(offer.turnId)).state, "Running");

  unreachable.mock.restore();
  await world.call("hostPresence", { tenantId: TENANT_ID, hostId: host.hostId, presence: "Offline", now: Date.now() });
  await world.passes(SECOND);

  const turn = await world.turn(offer.turnId);
  assert.equal(turn.state, "Failed");
  assert.equal(turn.state === "Failed" && turn.reason, "TurnTimedOut");
});
