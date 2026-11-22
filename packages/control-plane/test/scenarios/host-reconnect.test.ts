import assert from "node:assert/strict";
import { test } from "node:test";
import { World } from "./harness/world.ts";

test("a host that reconnects mid-turn keeps its running turn, and the turn's lines resume", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "write three lines", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  const line = (lineSeq: number) =>
    host.says({ type: "TurnLine", turnId: offer.turnId, lineSeq, text: `{"type":"assistant","n":${lineSeq}}` });
  await line(1);
  await line(2);

  await host.closesSocket();
  assert.equal((await world.turn(offer.turnId)).state, "Running");
  await world.passes(2_000);
  await host.reconnects([offer.turnId]);
  await line(3);
  await host.heartbeats([offer.turnId]);
  await host.heartbeats([offer.turnId]);

  assert.equal((await world.turn(offer.turnId)).state, "Running");
  const read = await world.transcript(session.sessionId, {});
  assert.deepEqual(
    read.lines.map((stored) => stored.lineSeq),
    [1, 2, 3],
  );
});

test("an offer the host never takes fails HostDropped on the heartbeat after the next one", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "an offer lost on the way", tags: [] });
  const offer = host.takeOffer();

  await host.heartbeats([]);
  assert.equal((await world.turn(offer.turnId)).state, "Offered");
  await host.heartbeats([]);

  const turn = await world.turn(offer.turnId);
  assert.equal(turn.state, "Failed");
  assert.equal(turn.state === "Failed" ? turn.reason : null, "HostDropped");
});
