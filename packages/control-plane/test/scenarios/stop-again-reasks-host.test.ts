import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { SnapshotRequestSchema } from "./harness/snapshot-chunks.ts";
import { TENANT_ID, World } from "./harness/world.ts";

test("a stop held by snapshots the host never answered asks the host again when stopped again, and reaches Stopped when the host holds no such box", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const { sessionId } = await world.startSession({ prompt: "lose the snapshot answer", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const lost = [SnapshotRequestSchema.parse(host.take("SnapshotRequest")).snapshotId];
  const queued = await world.sendTurn(sessionId, "run after the lost snapshot");

  await world.call("stopSession", {
    tenantId: TENANT_ID,
    sessionId,
    cancelledBy: "owner@scenario.test",
    now: Date.now(),
  });
  await world.settle();
  for (const request of host.received("SnapshotRequest")) {
    lost.push(SnapshotRequestSchema.parse(request).snapshotId);
    host.take("SnapshotRequest");
  }
  assert.equal((await world.session(sessionId)).state, "Stopping");
  assert.equal((await world.turn(queued.turnId)).state, "Failed");

  await world.call("stopSession", { tenantId: TENANT_ID, sessionId, cancelledBy: null, now: Date.now() });
  await world.settle();
  const failures = z.array(z.object({ reason: z.string() })).parse(
    world
      .tenantSql()
      .exec(`SELECT reason FROM snapshot_failures WHERE snapshot_id IN (${lost.map(() => "?").join(", ")})`, ...lost)
      .toArray(),
  );
  assert.deepEqual(
    failures.map((failure) => failure.reason),
    lost.map(() => "NotAnswered"),
  );
  const again = SnapshotRequestSchema.parse(host.take("SnapshotRequest"));
  assert.equal(again.sessionId, sessionId);
  await host.says({
    type: "SnapshotFailed",
    snapshotId: again.snapshotId,
    reason: "BoxNotFound",
    detail: "this host runs no box of the session",
    failedAt: new Date(Date.now()).toISOString(),
  });

  assert.equal((await world.session(sessionId)).state, "Stopped");
  assert.equal(host.received("BoxTeardown").length, 0);
});
