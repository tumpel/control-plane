import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import { failsSnapshot, sha256, snapshotAsked, TENANT_ID } from "./harness/snapshot-chunks.ts";
import { type Host, UNMETERED, World } from "./harness/world.ts";

const packKey = (packDigest: string): string => `${TENANT_ID}/packs/${packDigest}`;

const asked = async (world: World, host: Host): Promise<{ snapshotId: string; storageKey: string }> => {
  const session = await world.startSession({ prompt: "build the tree", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  return snapshotAsked(host, session.sessionId);
};

const namesRoot = async (
  world: World,
  host: Host,
  request: { snapshotId: string; storageKey: string },
  written: string[],
): Promise<void> => {
  const manifest = JSON.stringify({ entries: [] });
  const digest = createHash("sha256").update(manifest).digest("hex");
  const root = { digest, packDigest: digest, offset: 0, length: Buffer.byteLength(manifest) };
  await host.says({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: 1,
    packs: [digest, ...written].map((packDigest) => ({ packDigest, sizeBytes: root.length })),
    chunks: [root],
    reusedPackDigests: [],
  });
  await world.store.put(packKey(digest), manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
};

const done = (host: Host, snapshotId: string) =>
  host.says({ type: "SnapshotDone", snapshotId, uploadedBytes: 1, chunkCount: 1 });

test("a SnapshotDone with no root sends one SnapshotNotStored Rejected", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", { protocolVersion: ChannelProtocol.Version });
  const request = await asked(world, host);
  await world.store.delete(request.storageKey);
  await done(host, request.snapshotId);
  await world.settle();

  assert.deepEqual(host.received("SnapshotNotStored"), [
    { type: "SnapshotNotStored", snapshotId: request.snapshotId, reason: "Rejected" },
  ]);
});

test("a SnapshotDone naming a pack object storage does not hold sends one SnapshotNotStored PackMissing", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", { protocolVersion: ChannelProtocol.Version });
  const request = await asked(world, host);
  await namesRoot(world, host, request, [sha256("never uploaded")]);
  await done(host, request.snapshotId);
  await world.settle();

  assert.deepEqual(host.received("SnapshotNotStored"), [
    { type: "SnapshotNotStored", snapshotId: request.snapshotId, reason: "PackMissing" },
  ]);
});

test("a SnapshotDone after its request failed sends one SnapshotNotStored RequestNotPending", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", { protocolVersion: ChannelProtocol.Version });
  const request = await asked(world, host);
  await namesRoot(world, host, request, []);
  await failsSnapshot(host, request.snapshotId);
  await done(host, request.snapshotId);
  await world.settle();

  assert.deepEqual(host.received("SnapshotNotStored"), [
    { type: "SnapshotNotStored", snapshotId: request.snapshotId, reason: "RequestNotPending" },
  ]);
});

test("a stored snapshot sends no SnapshotNotStored, nor does its SnapshotDone sent again", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", { protocolVersion: ChannelProtocol.Version });
  const request = await asked(world, host);
  await namesRoot(world, host, request, []);
  await done(host, request.snapshotId);
  await done(host, request.snapshotId);
  await world.settle();

  assert.deepEqual(host.received("SnapshotNotStored"), []);
});

test(`a host on channel ${ChannelProtocol.Oldest} gets no SnapshotNotStored for a rejected snapshot and keeps its connection`, async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", { protocolVersion: ChannelProtocol.Oldest });
  const request = await asked(world, host);
  await world.store.delete(request.storageKey);
  await done(host, request.snapshotId);
  await world.settle();

  assert.deepEqual(host.received("SnapshotNotStored"), []);
  host.assertOpen("after the rejected snapshot");
});
