import assert from "node:assert/strict";
import { test } from "node:test";
import { LINES_PER_BATCH } from "./harness/supervisor.ts";
import { UNMETERED, World } from "./harness/world.ts";

const RESULT = '{"type":"result","subtype":"success","is_error":false}';
const assistant = (n: number): string => `{"type":"assistant","n":${n}}`;
const texts = (from: number, count: number): string[] => Array.from({ length: count }, (_, at) => assistant(from + at));
const TELEMETRY = {
  instruments: [{ metric: "host.load.1m", unit: "1", kind: "Sample" as const, description: "load" }],
  samples: [{ metric: "host.load.1m", at: "2026-11-23T10:00:00+01:00", value: 0.5, dimensions: {} }],
  turns: [],
};

const storedHost = async (world: World, name = "host-1") => world.online(world.owner, name);

const running = async (world: World, name?: string) => {
  const host = await storedHost(world, name);
  host.quiet();
  const session = await world.startSession({ prompt: "write lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  return { host, session, offer };
};

test("a TurnLines batch is acked once stored, and a batch of 200 lines writes the rows a batch of one does", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const { host, offer } = await running(world);
  const batch = async (from: number, count: number) => {
    const tenant = world.tenantRowsWritten();
    const channel = world.hostRows(host.hostId);
    const [seq] = await host.writes(offer.turnId, from, texts(from, count));
    assert.equal(host.acknowledgedSeq(), seq);
    assert.deepEqual(host.unackedSeqs(), []);
    return { tenant: world.tenantRowsWritten() - tenant, channel: world.hostRows(host.hostId) - channel };
  };

  await batch(1, 1);
  const one = await batch(2, 1);
  const full = await batch(3, LINES_PER_BATCH);
  assert.deepEqual(full, one);
  assert.equal(full.channel, 0);
});

test("a tenant restart mid-turn with the host resending from resendFrom loses and duplicates no line", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const { host, session, offer } = await running(world);
  await host.writes(offer.turnId, 1, texts(1, LINES_PER_BATCH));
  const message = {
    type: "TurnLines" as const,
    turnId: offer.turnId,
    firstLineSeq: LINES_PER_BATCH + 1,
    lines: texts(LINES_PER_BATCH + 1, 100),
  };
  const seq = host.send(message);
  const inFlight = { type: "Frame" as const, seq, ack: host.carried().received, message };

  await world.restartTenant();
  const resent = await world.reconnect(host, { unacked: [inFlight] });
  await world.settle();
  assert.equal(resent.closure(), null);
  assert.equal(resent.acknowledgedSeq(), seq);

  const last = LINES_PER_BATCH + 101;
  await resent.writes(offer.turnId, last, [RESULT]);
  await resent.says({
    type: "TurnComplete",
    turnId: offer.turnId,
    lastLineSeq: last,
    completedAt: new Date(Date.now()).toISOString(),
  });
  await resent.answersSnapshot(session.sessionId);
  assert.equal((await world.turn(offer.turnId)).state, "Completed");
  const lineSeqs: number[] = [];
  for (let after = 0; ; ) {
    const page = await world.transcript(session.sessionId, { after });
    if (page.lines.length === 0) break;
    lineSeqs.push(...page.lines.map((line) => line.lineSeq));
    after = page.cursor;
  }
  assert.deepEqual(
    lineSeqs,
    Array.from({ length: last }, (_, at) => at + 1),
  );
});

test("one idle host heartbeating for 10 minutes writes no host channel row and at most 20 tenant rows", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await storedHost(world);
  await world.settle();
  const channel = world.hostRows(host.hostId);
  const tenant = world.tenantRowsWritten();

  await world.passes(10 * 60_000);

  assert.equal(host.closure(), null);
  assert.equal(world.hostRows(host.hostId) - channel, 0);
  assert.ok(world.tenantRowsWritten() - tenant <= 20, `wrote ${world.tenantRowsWritten() - tenant} tenant rows`);
});

test("a turn of 201 lines, its telemetry on five heartbeats and a snapshot stays within its row budget", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await storedHost(world);
  host.quiet();
  await world.settle();
  const tenant = world.tenantRowsWritten();
  const channel = world.hostRows(host.hostId);

  const session = await world.startSession({ prompt: "fix the build", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.says({ type: "TurnRepositoryReady", turnId: offer.turnId });
  for (let round = 0; round < 5; round++) {
    await host.writes(offer.turnId, round * 40 + 1, texts(round * 40 + 1, 40));
    host.measures(TELEMETRY);
    await world.passes(1_000);
    await host.beats();
  }
  await host.writes(offer.turnId, 201, [RESULT]);
  await host.says({
    type: "TurnComplete",
    turnId: offer.turnId,
    lastLineSeq: 201,
    completedAt: new Date(Date.now()).toISOString(),
  });
  await host.answersSnapshot(session.sessionId);
  assert.equal((await world.turn(offer.turnId)).state, "Completed");

  const spent = { tenant: world.tenantRowsWritten() - tenant, channel: world.hostRows(host.hostId) - channel };
  assert.ok(
    spent.tenant <= 53 + 3 + 5 && spent.channel <= 5,
    `the turn wrote ${JSON.stringify(spent)} rows, including 5 for SessionStarted and one extra index charge each for TurnStarted, TurnCompleted and SessionIdle`,
  );
});
