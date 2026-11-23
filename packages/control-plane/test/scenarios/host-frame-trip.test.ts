import assert from "node:assert/strict";
import { test } from "node:test";
import { CloseCode } from "@tumpel/schemas";
import type { Supervisor } from "./harness/supervisor.ts";
import { LIMITS, World } from "./harness/world.ts";

const FRAMES_PER_MINUTE = 20;
const START = Date.parse("2026-11-23T10:00:30Z");
const LINE = '{"type":"assistant","n":1}';

const snapshotFailed = (snapshotId: string) => ({
  type: "SnapshotFailed" as const,
  snapshotId,
  reason: "BoxNotFound" as const,
  detail: "no box",
  failedAt: "2026-11-23T10:00:00+01:00",
});

const runningTurn = async (t: { after(fn: () => void): void }) => {
  const world = await World.open({ start: START, limits: { ...LIMITS, hostFramesPerMinute: FRAMES_PER_MINUTE } });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "stream past the limit", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await world.settle();
  return { world, host, offer };
};

const fillMinute = async (world: World, host: Supervisor): Promise<void> => {
  for (let seq = host.carried().sent + 1; seq <= FRAMES_PER_MINUTE; seq++) host.send(snapshotFailed(`unknown-${seq}`));
  await world.settle();
};

test("a host over its frame budget gets FrameRateLimited with retryAfter, its turn stays Running, the trip writes no tenant row, and its resend after retryAfter lands with no gap", async (t) => {
  const { world, host, offer } = await runningTurn(t);
  await fillMinute(world, host);
  const rows = world.tenantRowsWritten();

  const over = host.send({ type: "TurnLines", turnId: offer.turnId, firstLineSeq: 1, lines: [LINE] });
  await world.settle();

  assert.deepEqual(host.rateLimited(), [over]);
  assert.deepEqual(host.retryAfter(), ["2026-11-23T10:01:00.000Z"]);
  assert.deepEqual(host.unackedSeqs(), [over]);
  assert.equal(world.tenantRowsWritten() - rows, 0);
  assert.equal((await world.turn(offer.turnId)).state, "Running");
  assert.equal(host.closure(), null);

  await world.tick(30_000);
  host.resendsUnacked();
  await world.settle();

  assert.deepEqual(host.unackedSeqs(), []);
  assert.equal(host.closure(), null);
  assert.equal((await world.turn(offer.turnId)).state, "Running");
  assert.deepEqual(
    (await world.transcript(offer.sessionId, {})).lines.map((line) => line.lineSeq),
    [1],
  );
});

test("a host channel restarted mid-window keeps the frame budget the minute already spent", async (t) => {
  const { world, host, offer } = await runningTurn(t);
  await fillMinute(world, host);

  world.hibernateHostChannel(host.hostId);
  const over = host.send({ type: "TurnLines", turnId: offer.turnId, firstLineSeq: 1, lines: [LINE] });
  await world.settle();

  assert.deepEqual(host.rateLimited(), [over]);
  assert.notEqual(host.closure()?.code, CloseCode.ProtocolError);
  assert.equal((await world.turn(offer.turnId)).state, "Running");
});
