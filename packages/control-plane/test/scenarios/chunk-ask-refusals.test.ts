import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "./harness/snapshot-chunks.ts";
import { World } from "./harness/world.ts";

test("a snapshot chunk ask after its upload window expires is refused", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "leave the snapshot unanswered", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const { snapshotId } = await host.next("SnapshotRequest");
  await world.tick(world.settings.snapshotDeadlineSeconds * 1000);

  const seq = host.send({ type: "SnapshotChunks", snapshotId, part: 1, digests: [sha256("chunk")] });
  const refusal = await host.refusal();
  assert.equal(refusal.seq, seq);
  assert.ok(refusal.reason.includes(`upload window for snapshot ${snapshotId} has expired`), refusal.reason);
});
