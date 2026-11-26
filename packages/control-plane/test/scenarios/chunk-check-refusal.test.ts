import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import { UNMETERED, World } from "./harness/world.ts";

test("a chunk check or index ask from a v41 host is refused by name, and the channel takes the next frame", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", { protocolVersion: ChannelProtocol.Version });
  host.quiet();
  const digest = "a".repeat(64);
  const before = world.tenantRowsWritten();

  const checked = host.send({ type: "SnapshotChunkCheck", snapshotId: "snapshot-1", check: 1, digests: [digest] });
  assert.deepEqual(await host.refusal(), {
    seq: checked,
    reason: "the control plane does not answer SnapshotChunkCheck",
  });
  const asked = host.send({ type: "SnapshotIndexAsk", snapshotId: "snapshot-1", sizeBytes: 60, digest });
  assert.deepEqual(await host.refusal(), { seq: asked, reason: "the control plane does not answer SnapshotIndexAsk" });

  assert.equal(world.tenantRowsWritten() - before, 0);
  const session = await world.startSession({ prompt: "still served", tags: [] });
  assert.equal(host.takeOffer().sessionId, session.sessionId);
});
