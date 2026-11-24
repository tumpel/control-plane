import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { SnapshotRequestSchema } from "./harness/snapshot-chunks.ts";
import { TENANT_ID, World } from "./harness/world.ts";

test("a stop held by snapshots whose upload URLs expired unanswered asks the host again when stopped again, and reaches Stopped when the host holds no such box", async (t) => {
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

  const expired = Date.now() + (world.settings.snapshotDeadlineSeconds + 1) * 1000;
  await world.call("stopSession", { tenantId: TENANT_ID, sessionId, cancelledBy: null, now: expired });
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

test("a stop held by a snapshot still inside its upload window leaves it alone when stopped again, and the host storing it completes the stop", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const { sessionId } = await world.startSession({ prompt: "upload a large box", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  await world.call("stopSession", {
    tenantId: TENANT_ID,
    sessionId,
    cancelledBy: "owner@scenario.test",
    now: Date.now(),
  });
  await world.settle();
  const asked = host.received("SnapshotRequest").length;

  await world.call("stopSession", { tenantId: TENANT_ID, sessionId, cancelledBy: null, now: Date.now() });
  await world.settle();

  assert.equal(host.received("SnapshotRequest").length, asked);
  assert.deepEqual(
    world.tenantSql().exec("SELECT snapshot_id FROM snapshot_failures WHERE session_id = ?", sessionId).toArray(),
    [],
  );
  assert.equal((await world.session(sessionId)).state, "Stopping");
  for (let answered = 0; answered < asked; answered += 1) await host.answersSnapshot(sessionId);
  const teardown = z.object({ boxId: z.string() }).parse(host.take("BoxTeardown"));
  await host.says({ type: "BoxGone", sessionId, boxId: teardown.boxId });

  assert.equal((await world.session(sessionId)).state, "Stopped");
});

test("a stop held by an expired turn snapshot and a live stop snapshot re-asks only the expired one when stopped again, and the live upload still completes the stop", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const { sessionId } = await world.startSession({ prompt: "lose the turn snapshot", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const lost = SnapshotRequestSchema.parse(host.take("SnapshotRequest"));
  await world.tick((world.settings.snapshotDeadlineSeconds + 1) * 1000);
  await world.call("stopSession", {
    tenantId: TENANT_ID,
    sessionId,
    cancelledBy: "owner@scenario.test",
    now: Date.now(),
  });
  await world.settle();
  const asked = host.received("SnapshotRequest").length;

  await world.call("stopSession", { tenantId: TENANT_ID, sessionId, cancelledBy: null, now: Date.now() });
  await world.settle();

  assert.equal(host.received("SnapshotRequest").length, asked + 1);
  assert.deepEqual(
    z
      .array(z.object({ snapshot_id: z.string(), reason: z.string() }))
      .parse(
        world
          .tenantSql()
          .exec("SELECT snapshot_id, reason FROM snapshot_failures WHERE session_id = ?", sessionId)
          .toArray(),
      ),
    [{ snapshot_id: lost.snapshotId, reason: "NotAnswered" }],
  );
  for (let answered = 0; answered < asked + 1; answered += 1) await host.answersSnapshot(sessionId);
  const teardown = z.object({ boxId: z.string() }).parse(host.take("BoxTeardown"));
  await host.says({ type: "BoxGone", sessionId, boxId: teardown.boxId });

  assert.equal((await world.session(sessionId)).state, "Stopped");
});
