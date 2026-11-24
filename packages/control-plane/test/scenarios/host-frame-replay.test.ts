import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ClaudeSetupSchema, SecretSetSchema } from "@tumpel/schemas";
import type { HostMessage } from "./harness/supervisor.ts";
import { TENANT_ID, UNMETERED, World } from "./harness/world.ts";

const RESULT = '{"type":"result","subtype":"success","is_error":false}';
const FAILED_AT = "2026-11-23T10:00:00+01:00";
const SIGNED = /Url$|ExpiresAt$|Seconds$/;

const unsigned = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(unsigned);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) => (SIGNED.test(key) ? [] : [[key, unsigned(field)]])),
  );
};

const once = async (world: World, hostId: string, message: HostMessage): Promise<unknown> => {
  const apply = () => world.call("hostMessage", { tenantId: TENANT_ID, hostId, message });
  const first = await apply();
  await world.settle();
  const rows = world.tenantRowsWritten();
  const second = await apply();
  await world.settle();
  assert.deepEqual(unsigned(second), unsigned(first), `${message.type} answered its replay differently`);
  assert.equal(world.tenantRowsWritten() - rows, 0, `${message.type} applied again on its replay`);
  return first;
};

const opened = async (t: { after(fn: () => void): void }) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  host.quiet();
  return { world, host };
};

test("every turn, snapshot, restore and teardown frame applied twice has one effect and the same reply", async (t) => {
  const { world, host } = await opened(t);
  const session = await world.startSession({ prompt: "replay every frame", tags: [] });
  const offer = host.takeOffer();
  const { turnId, boxId, sessionId } = offer;

  await once(world, host.hostId, { type: "TurnImageFetching", turnId, imageDigest: "a".repeat(64) });
  assert.deepEqual(await once(world, host.hostId, { type: "TurnClaim", turnId, boxId }), {
    reply: { type: "TurnClaimed", turnId },
  });
  await once(world, host.hostId, { type: "TurnRepositoryReady", turnId });
  await once(world, host.hostId, {
    type: "TurnLines",
    turnId,
    firstLineSeq: 1,
    lines: ['{"type":"assistant","n":1}', RESULT],
  });
  await once(world, host.hostId, { type: "TurnComplete", turnId, lastLineSeq: 2, completedAt: FAILED_AT });

  const request = await host.next("SnapshotRequest");
  const manifest = JSON.stringify({ entries: [] });
  const digest = createHash("sha256").update(manifest).digest("hex");
  const chunk = { digest, packDigest: digest, offset: 0, length: manifest.length };
  await once(world, host.hostId, {
    type: "SnapshotChunks",
    snapshotId: request.snapshotId,
    part: 1,
    digests: [digest],
  });
  await once(world, host.hostId, {
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: 1,
    packs: [{ packDigest: digest, sizeBytes: manifest.length }],
    chunks: [chunk],
    reusedPackDigests: [],
  });
  const draft = async () => (await world.store.get(`${request.storageKey}.draft`))?.text();
  assert.deepEqual(
    await world.call("hostMessage", {
      tenantId: TENANT_ID,
      hostId: host.hostId,
      message: {
        type: "SnapshotPacks",
        snapshotId: request.snapshotId,
        part: 3,
        packs: [],
        chunks: [],
        reusedPackDigests: [digest],
      },
    }),
    {
      reply: {
        type: "Refused",
        reason: `host ${host.hostId} sent SnapshotPacks part 3 of snapshot ${request.snapshotId}, but the control plane expects part 2, so the snapshot cannot name its packs`,
      },
    },
  );
  await world.store.put(`${TENANT_ID}/packs/${digest}`, manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [chunk] }));
  await once(world, host.hostId, {
    type: "SnapshotDone",
    snapshotId: request.snapshotId,
    uploadedBytes: 14,
    chunkCount: 1,
  });
  assert.equal(await (await world.store.get(`${request.storageKey}.packs`))?.text(), JSON.stringify([digest]));
  assert.equal(await draft(), undefined);
  assert.equal((await world.turn(turnId)).state, "Completed");
  assert.equal((await world.session(session.sessionId)).state, "Idle");

  const restoring = await world.sendTurn(sessionId, "restore and fail");
  host.take("TurnOffer");
  await once(world, host.hostId, { type: "RestoreChunks", turnId: restoring.turnId, part: 1, chunks: [chunk] });
  await once(world, host.hostId, { type: "TurnClaim", turnId: restoring.turnId, boxId });
  await once(world, host.hostId, {
    type: "TurnFailed",
    turnId: restoring.turnId,
    reason: "HarnessExited",
    detail: "the harness exited",
    failedAt: FAILED_AT,
  });
  assert.equal((await world.turn(restoring.turnId)).state, "Failed");
  await world.settle();

  await world.call("stopSession", { tenantId: TENANT_ID, sessionId, cancelledBy: null, now: Date.now() });
  await once(world, host.hostId, {
    type: "BoxTeardownFailed",
    sessionId,
    boxId,
    reason: "BoxDirty",
    detail: "the box is busy",
    failedAt: FAILED_AT,
  });
  assert.equal((await world.session(sessionId)).state, "Idle");
  await once(world, host.hostId, { type: "BoxGone", sessionId, boxId });
  assert.equal((await world.session(sessionId)).state, "Stopped");
});

test("a SnapshotPacks part that brings the snapshot past the pack limit is refused and leaves its draft as it was", async (t) => {
  const { world, host } = await opened(t);
  await world.startSession({ prompt: "too many packs", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const request = await host.next("SnapshotRequest");
  const digestsOf = (part: number): string[] =>
    Array.from({ length: 500 }, (_, at) => createHash("sha256").update(`${part}/${at}`).digest("hex"));
  const part = (number: number) =>
    world.call("hostMessage", {
      tenantId: TENANT_ID,
      hostId: host.hostId,
      message: {
        type: "SnapshotPacks",
        snapshotId: request.snapshotId,
        part: number,
        packs: [],
        chunks: [],
        reusedPackDigests: digestsOf(number),
      },
    });
  for (let number = 1; number <= 32; number++) await part(number);
  const draft = async () => (await world.store.get(`${request.storageKey}.draft`))?.text();
  const before = await draft();
  assert.deepEqual(await part(33), {
    reply: {
      type: "Refused",
      reason: `host ${host.hostId} sent SnapshotPacks part 33 of snapshot ${request.snapshotId}, which brings it to 16500 packs, above the 16384 the control plane indexes, so the snapshot cannot name its packs`,
    },
  });
  assert.equal(await draft(), before);
});

test("a clone failure, a snapshot failure, a box gone under a turn and a Claude setup's frames applied twice have one effect and the same reply", async (t) => {
  const { world, host } = await opened(t);
  await world.startSession({ prompt: "clone fails", tags: [] });
  const cloning = host.takeOffer();
  await once(world, host.hostId, { type: "TurnClaim", turnId: cloning.turnId, boxId: cloning.boxId });
  const cloneFailed: HostMessage = {
    type: "TurnRepositoryCloneFailed",
    turnId: cloning.turnId,
    cause: "Refused",
    detail: "git reported: fatal: could not read Username",
    failedAt: FAILED_AT,
  };
  const discarded = await world.call("hostMessage", { tenantId: TENANT_ID, hostId: host.hostId, message: cloneFailed });
  assert.equal((await world.turn(cloning.turnId)).state, "Failed");
  await world.settle();
  world
    .tenantStorage(TENANT_ID)
    .sql.exec("UPDATE sessions SET box_id = ? WHERE session_id = ?", "box-new", cloning.sessionId);
  const rows = world.tenantRowsWritten();
  assert.deepEqual(
    await world.call("hostMessage", { tenantId: TENANT_ID, hostId: host.hostId, message: cloneFailed }),
    discarded,
  );
  assert.deepEqual(discarded, {
    reply: { type: "BoxDiscard", sessionId: cloning.sessionId, boxId: cloning.boxId },
  });
  assert.equal(world.tenantRowsWritten() - rows, 0);

  await world.startSession({ prompt: "snapshot fails", tags: [] });
  const snapshotting = host.takeOffer();
  await host.claims(snapshotting);
  await host.completes(snapshotting);
  const request = await host.next("SnapshotRequest");
  await once(world, host.hostId, {
    type: "SnapshotFailed",
    snapshotId: request.snapshotId,
    reason: "UploadRejected",
    detail: "the store refused the upload",
    failedAt: FAILED_AT,
  });

  await world.startSession({ prompt: "box gone while running", tags: [] });
  const losing = host.takeOffer();
  await host.claims(losing);
  await host.completes(losing);
  host.take("SnapshotRequest");
  await once(world, host.hostId, { type: "BoxGone", sessionId: losing.sessionId, boxId: losing.boxId });
  assert.equal((await world.turn(losing.turnId)).state, "Failed");

  const created = await world.fetch(
    world.owner,
    "POST",
    "/v1/secret-sets",
    JSON.stringify({ name: "setup", secrets: [] }),
  );
  const { secretSetId } = SecretSetSchema.parse(await created.json());
  const started = await world.fetch(world.owner, "POST", "/v1/claude-setups", JSON.stringify({ secretSetId }));
  const { claudeSetupId } = ClaudeSetupSchema.parse(await started.json());
  host.take("ClaudeSetupBoxOffer");
  await once(world, host.hostId, {
    type: "ClaudeSetupBoxUrl",
    claudeSetupId,
    signInUrl: "https://claude.ai/oauth/authorize?state=replay",
  });
  await once(world, host.hostId, {
    type: "ClaudeSetupBoxFailed",
    claudeSetupId,
    reason: "SetupUrlMissing",
    detail: "the replay fails this setup",
    failedAt: FAILED_AT,
  });
});

test("a supervisor update step and failure applied twice leave one record of each", async (t) => {
  const { world, host } = await opened(t);
  const recorded = () => {
    const sql = world.tenantStorage(TENANT_ID).sql;
    return {
      steps: sql.exec("SELECT * FROM supervisor_update_latest_steps WHERE host_id = ?", host.hostId).toArray(),
      failures: sql.exec("SELECT * FROM supervisor_update_latest_failures WHERE host_id = ?", host.hostId).toArray(),
    };
  };
  const messages = [
    {
      type: "SupervisorUpdateStep",
      fromSha256: "a".repeat(64),
      toSha256: "b".repeat(64),
      releaseVersion: "v0.4.3",
      boxesRunning: 0,
      phase: "Restarting",
      at: FAILED_AT,
    },
    {
      type: "SupervisorUpdateFailed",
      fromSha256: "a".repeat(64),
      toSha256: "b".repeat(64),
      reason: "SupervisorUpdateDryRunFailed",
      detail: "the candidate died with SIGFPE",
      outputTail: [],
      failedAt: FAILED_AT,
    },
  ];
  for (const message of messages) await world.call("supervisorUpdate", { hostId: host.hostId, message });
  const first = recorded();
  for (const message of messages) await world.call("supervisorUpdate", { hostId: host.hostId, message });
  assert.deepEqual(recorded(), first);
  assert.deepEqual([first.steps.length, first.failures.length], [1, 1]);
});
