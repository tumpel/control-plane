import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const uploading = [SnapshotRequestSchema.parse(host.take("SnapshotRequest"))];
  await world.call("stopSession", {
    tenantId: TENANT_ID,
    sessionId,
    cancelledBy: "owner@scenario.test",
    now: Date.now(),
  });
  await world.settle();
  for (const request of host.received("SnapshotRequest")) {
    uploading.push(SnapshotRequestSchema.parse(request));
    host.take("SnapshotRequest");
  }

  await world.call("stopSession", { tenantId: TENANT_ID, sessionId, cancelledBy: null, now: Date.now() });
  await world.settle();

  assert.equal(host.received("SnapshotRequest").length, 0);
  assert.deepEqual(
    world.tenantSql().exec("SELECT snapshot_id FROM snapshot_failures WHERE session_id = ?", sessionId).toArray(),
    [],
  );
  assert.equal((await world.session(sessionId)).state, "Stopping");
  const manifest = JSON.stringify({ entries: [] });
  const digest = createHash("sha256").update(manifest).digest("hex");
  await world.store.put(`${TENANT_ID}/packs/${digest}`, manifest);
  const root = { digest, packDigest: digest, offset: 0, length: manifest.length };
  for (const request of uploading) {
    await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
    await host.says({
      type: "SnapshotPacks",
      snapshotId: request.snapshotId,
      part: 1,
      packs: [{ packDigest: digest, sizeBytes: manifest.length }],
      chunks: [root],
      reusedPackDigests: [],
    });
    await host.says({
      type: "SnapshotDone",
      snapshotId: request.snapshotId,
      uploadedBytes: manifest.length,
      chunkCount: 0,
    });
  }
  const teardown = z.object({ boxId: z.string() }).parse(host.take("BoxTeardown"));
  await host.says({ type: "BoxGone", sessionId, boxId: teardown.boxId });

  assert.equal((await world.session(sessionId)).state, "Stopped");
});
