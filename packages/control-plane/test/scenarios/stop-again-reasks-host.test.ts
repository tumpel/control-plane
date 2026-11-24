import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { SnapshotRequestSchema } from "./harness/snapshot-chunks.ts";
import { TENANT_ID, World } from "./harness/world.ts";

test("a stop held by snapshots the host never answered asks the host again when stopped again, and reaches Stopped when the host holds no such box", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "plan the epic", tags: ["role:foreman"] });
  const stop = (cancelledBy: string | null) =>
    world.call("stopSession", { tenantId: TENANT_ID, sessionId: foreman.sessionId, cancelledBy, now: Date.now() });
  const asked = () =>
    host
      .received("SnapshotRequest")
      .map((frame) => SnapshotRequestSchema.parse(frame))
      .filter((request) => request.sessionId === foreman.sessionId);
  const dropped = (): string[] => {
    const requests = asked();
    for (const _ of requests) host.take("SnapshotRequest");
    return requests.map((request) => request.snapshotId);
  };
  await world.subscribe(foreman, {
    prompt: "hand out the next step of the epic",
    goal: "the epic is merged",
    events: ["TurnCompleted"],
    crewTags: ["crew:epic"],
  });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.completes(foremanTurn);
  const lost = dropped();

  await world.startSession({ prompt: "build part one", tags: ["crew:epic"] });
  const crewTurn = host.takeOffer();
  await host.claims(crewTurn);
  await host.finishes(crewTurn);

  await stop("owner@scenario.test");
  await world.settle();
  lost.push(...dropped());
  assert.equal((await world.session(foreman.sessionId)).state, "Stopping");
  const queued = z
    .array(z.object({ turn_id: z.string() }))
    .parse(
      world
        .tenantSql()
        .exec("SELECT turn_id FROM turns WHERE session_id = ? AND state = 'Offered'", foreman.sessionId)
        .toArray(),
    );
  assert.equal(queued.length, 1, "a delivery turn waits on the stopping foreman");

  await stop(null);
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
  const [again] = asked();
  assert.ok(again !== undefined, "the second stop asks the host for a snapshot again");
  host.take("SnapshotRequest");
  await host.says({
    type: "SnapshotFailed",
    snapshotId: again.snapshotId,
    reason: "BoxNotFound",
    detail: "this host runs no box of the session",
    failedAt: new Date(Date.now()).toISOString(),
  });
  const teardown = z.object({ sessionId: z.string(), boxId: z.string() }).parse(host.take("BoxTeardown"));
  assert.equal(teardown.boxId, foremanTurn.boxId);
  await host.says({ type: "BoxGone", sessionId: foreman.sessionId, boxId: teardown.boxId });

  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.notEqual(delivery.boxId, foremanTurn.boxId, "the queued delivery runs on a fresh box");
});
