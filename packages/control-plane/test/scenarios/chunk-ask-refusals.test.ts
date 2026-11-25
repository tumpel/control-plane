import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "./harness/snapshot-chunks.ts";
import { World } from "./harness/world.ts";

test("a restore chunk ask after the session stop ends its turn is refused", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const { sessionId } = await world.startSession({ prompt: "store a snapshot", tags: [] });
  const first = host.takeOffer();
  await host.claims(first);
  await host.finishes(first);
  await host.dropsIdleBox(first);

  const { turnId } = await world.sendTurn(sessionId, "restore the snapshot");
  const restoring = host.takeOffer();
  assert.equal(restoring.turnId, turnId);
  await host.claims(restoring);
  const manifest = JSON.stringify({ entries: [] });
  const digest = sha256(manifest);
  const chunks = [{ digest, packDigest: digest, offset: 0, length: manifest.length }];
  host.send({ type: "RestoreChunks", turnId, part: 1, chunks });
  assert.equal((await host.next("RestoreDownloads")).packs[0]?.packDigest, digest);

  const stopped = await world.fetch(world.owner, "POST", `/v1/sessions/${sessionId}/stop?cancelTurn=true`);
  assert.equal(stopped.status, 200, await stopped.text());
  assert.equal((await world.turn(turnId)).state, "Failed");

  const seq = host.send({ type: "RestoreChunks", turnId, part: 2, chunks });
  const refusal = await host.refusal();
  assert.equal(refusal.seq, seq);
  assert.ok(refusal.reason.includes(`turn ${turnId} has ended`), refusal.reason);
});

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
