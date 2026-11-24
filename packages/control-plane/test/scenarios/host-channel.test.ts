import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol, CloseCode } from "@tumpel/schemas";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { World } from "./harness/world.ts";

const RESULT = '{"type":"result","subtype":"success","is_error":false}';
const assistant = (n: number): string => `{"type":"assistant","n":${n}}`;

test("a tenant that restarts mid-turn keeps the host channel open, and the turn completes with every line once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "write three lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.says({ type: "TurnLines", turnId: offer.turnId, firstLineSeq: 1, lines: [assistant(1)] });
  host.report(DEFAULT_USAGE);
  await world.settle();
  await host.says({ type: "TurnLines", turnId: offer.turnId, firstLineSeq: 2, lines: [assistant(2)] });

  await world.restartTenant();
  host.report(DEFAULT_USAGE);
  await world.settle();
  assert.equal(host.closure(), null, "the tenant restart closed the host channel");
  await host.says({ type: "TurnLines", turnId: offer.turnId, firstLineSeq: 3, lines: [RESULT] });
  await host.says({
    type: "TurnComplete",
    turnId: offer.turnId,
    lastLineSeq: 3,
    completedAt: new Date(Date.now()).toISOString(),
  });
  await world.until(
    "a SnapshotRequest after the restart",
    () => host.received("SnapshotRequest").length,
    (requests) => requests > 0,
  );
  await host.answersSnapshot(session.sessionId);
  assert.equal((await world.turn(offer.turnId)).state, "Completed");
  assert.deepEqual(
    (await world.transcript(session.sessionId, {})).lines.map((line) => line.lineSeq),
    [1, 2, 3],
  );
});

test("a 39 host has each frame acked once stored, so a hibernation between heartbeats loses nothing and the next frame lands", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", { protocolVersion: ChannelProtocol.Oldest });
  const session = await world.startSession({ prompt: "write two lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.writes(offer.turnId, 1, [assistant(1)]);
  await world.settle();
  assert.deepEqual(host.unackedSeqs(), []);

  world.hibernateHostChannel(host.hostId);
  await host.writes(offer.turnId, 2, [RESULT]);
  await world.settle();
  assert.equal(host.closure(), null);
  assert.deepEqual(host.unackedSeqs(), []);
  assert.deepEqual(
    (await world.transcript(session.sessionId, {})).lines.map((line) => line.lineSeq),
    [1, 2],
  );
});

test("a host that reconnects with a frame the control plane never received resends it after Welcome, and it lands in the transcript once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "write two lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await world.settle();
  const carried = host.carried();
  const lost = {
    type: "Frame" as const,
    seq: carried.sent + 1,
    ack: carried.received,
    message: { type: "TurnLines" as const, turnId: offer.turnId, firstLineSeq: 1, lines: [assistant(1)] },
  };

  const reconnected = await world.reconnect(host, { carried: { ...carried, sent: lost.seq }, unacked: [lost] });
  assert.equal((await host.closed()).code, CloseCode.Replaced);
  await world.until(
    "the resent line acked",
    () => reconnected.unackedSeqs(),
    (seqs) => seqs.length === 0,
  );

  await reconnected.says({ type: "TurnLines", turnId: offer.turnId, firstLineSeq: 2, lines: [RESULT] });
  await reconnected.says({
    type: "TurnComplete",
    turnId: offer.turnId,
    lastLineSeq: 2,
    completedAt: new Date(Date.now()).toISOString(),
  });
  await reconnected.answersSnapshot(session.sessionId);
  assert.equal((await world.turn(offer.turnId)).state, "Completed");
  assert.deepEqual(
    (await world.transcript(session.sessionId, {})).lines.map((line) => line.lineSeq),
    [1, 2],
  );
});
