import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import { UNMETERED, World } from "./harness/world.ts";

const RESULT = '{"type":"result","subtype":"success","is_error":false}';

const turnOn = async (protocolVersion: number) => {
  const world = await World.open({ limits: UNMETERED });
  try {
    await world.holdsAgentCredentials();
    const host = await world.online(world.owner, "host-1", { protocolVersion, channelProtocolOldest: protocolVersion });
    host.quiet();
    const session = await world.startSession({ prompt: "answer in two lines", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    const start = world.tenantRowsWritten();
    await host.says({
      type: "TurnLines",
      turnId: offer.turnId,
      firstLineSeq: 1,
      lines: ['{"type":"assistant","n":1}', RESULT],
    });
    await host.says({
      type: "TurnComplete",
      turnId: offer.turnId,
      lastLineSeq: 2,
      completedAt: new Date(Date.now()).toISOString(),
    });
    await host.answersSnapshot(session.sessionId);
    const turn = await world.turn(offer.turnId);
    return {
      welcomedOn: host.welcomedVersion(),
      welcomedWith: host.welcomedWith(),
      state: turn.state,
      rows: world.tenantRowsWritten() - start,
    };
  } finally {
    await world.close();
  }
};

test(`a channel ${ChannelProtocol.Version} host is welcomed on ${ChannelProtocol.Version} with no ack and completes a turn on the rows a channel ${ChannelProtocol.Oldest} host writes`, async () => {
  const oldest = await turnOn(ChannelProtocol.Oldest);
  const newest = await turnOn(ChannelProtocol.Version);

  assert.equal(oldest.welcomedOn, ChannelProtocol.Oldest);
  assert.equal(newest.welcomedOn, ChannelProtocol.Version);
  assert.deepEqual(newest.welcomedWith.sort(), ["hostId", "protocolVersion", "type"]);
  assert.equal(oldest.state, "Completed");
  assert.equal(newest.state, "Completed");
  assert.equal(newest.rows, oldest.rows);
});
