import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  CloseCode,
  EnrolmentTokenSchema,
  HostRecordSchema,
  HostSchema,
  MintedEnrolmentTokenSchema,
  ProblemSchema,
  ReportedHostUsageSchema,
} from "@tumpel/schemas";
import { z } from "zod";
import { hostKey } from "./harness/supervisor.ts";
import { LIMITS, type Member, SETTINGS, World } from "./harness/world.ts";

const EMAIL = "hosts@example.test";
const RAISED = { ...LIMITS.ceiling, hostFramesPerMinute: 1200 };

let world: World;
let member: Member;

before(async () => {
  world = await World.open({
    limits: { ...LIMITS, readsPerMinute: 1_000_000, writesPerMinute: 1_000_000, ceiling: RAISED },
  });
  member = await world.signUp("Hosts", EMAIL);
});

after(() => world.close());

const getJson = async (path: string): Promise<unknown> => {
  const response = await world.fetch(member, "GET", path);
  assert.equal(response.status, 200, `GET ${path}: ${await response.clone().text()}`);
  return response.json();
};

const readHost = async (hostId: string) => HostSchema.parse(await getJson(`/v1/hosts/${hostId}`));

const reads = (hostId: string, state: string) =>
  world.until(
    `host ${hostId} reading ${state}`,
    async () => (await readHost(hostId)).state,
    (read) => read === state,
  );

const mint = async (): Promise<string> => {
  const response = await world.fetch(member, "POST", "/v1/enrolment-tokens", JSON.stringify({ expiresInSeconds: 600 }));
  assert.equal(response.status, 200);
  return MintedEnrolmentTokenSchema.parse(await response.json()).token;
};

const enrolWith = (name: string, enrolmentToken: string, publicKey = hostKey().publicKey) =>
  world.postJson("/v1/hosts/enrol", {
    name,
    architecture: "Amd64",
    cpuCount: 1,
    memoryBytes: 1024,
    publicKey,
    supervisorVersion: "0.1.0",
    enrolmentToken,
  });

const snapshotFailed = (snapshotId: string) => ({
  type: "SnapshotFailed",
  snapshotId,
  reason: "BoxNotFound",
  detail: "no box",
  failedAt: "2026-11-15T10:00:00+01:00",
});

test("a host enrols with a one-time token, holds its channel, reads Degraded when it falls silent, and stops on revoke", async () => {
  const token = await mint();
  const key = hostKey();
  const first = await enrolWith("first", token, key.publicKey);
  assert.equal(first.status, 200);
  const host = HostRecordSchema.parse(await first.json());
  assert.equal(host.state, "Enrolled");
  assert.equal(host.name, "first");

  const second = await enrolWith("second", token);
  assert.equal(second.status, 410);
  assert.equal(ProblemSchema.parse(await second.json()).title, "Enrolment token spent");

  const supervisor = await world.connect(host.hostId, key);
  await reads(host.hostId, "Online");
  assert.deepEqual(
    HostSchema.array()
      .parse(await getJson("/v1/hosts"))
      .filter((row) => row.hostId === host.hostId)
      .map((row) => row.state),
    ["Online"],
  );

  supervisor.quiet();
  await world.passes((SETTINGS.heartbeatDeadlineSeconds + 1) * 1000);
  const silent = await readHost(host.hostId);
  assert.equal(silent.state, "Online");
  assert.equal(silent.presence, "Degraded");
  supervisor.resumes();
  await world.until(
    `host ${host.hostId} heard again`,
    () => readHost(host.hostId),
    (read) => read.presence === "Online",
  );

  const revoked = await world.fetch(member, "POST", `/v1/hosts/${host.hostId}/revoke`, "{}");
  assert.equal(revoked.status, 200);
  assert.equal(HostSchema.parse(await revoked.json()).state, "Revoked");
  assert.equal((await supervisor.closed()).code, CloseCode.Revoked);
  assert.equal((await readHost(host.hostId)).state, "Revoked");
  assert.deepEqual(
    ReportedHostUsageSchema.array()
      .parse(await getJson("/v1/hosts/usage"))
      .filter((row) => row.hostId === host.hostId),
    [],
  );

  const again = await world.connect(host.hostId, key);
  assert.equal((await again.closed()).code, CloseCode.Revoked);
});

test("a connected host's samples land in its tenant's metrics store under its signed host id", async () => {
  const supervisor = await world.online(member, "telemetry");
  const at = new Date().toISOString();
  supervisor.send({
    type: "TelemetryBatch",
    instruments: [{ metric: "host.memory.total", unit: "By", kind: "Sample", description: "Total memory" }],
    samples: [{ metric: "host.memory.total", at, value: 1024, dimensions: { hostId: "forged" } }],
    turns: [],
  });
  await world.until(
    `host ${supervisor.hostId}'s host.memory.total reaching the metrics store`,
    () => world.dataPoints.map(({ blobs }) => ({ metric: blobs?.[0], dimensions: blobs?.[1] ?? "{}" })),
    (series) =>
      series.some(
        ({ metric, dimensions }) =>
          metric === "host.memory.total" &&
          z.object({ hostId: z.string() }).parse(JSON.parse(dimensions)).hostId === supervisor.hostId,
      ),
  );
});

test("a frame the host sends the moment Welcome arrives is accepted while the tenant's hostHello is still in flight", async () => {
  const { Tenant } = (await import(new URL("../../src/tenant.ts", import.meta.url).href)) as {
    Tenant: { prototype: Record<string, unknown> };
  };
  const inherited = Tenant.prototype.hostHello as (...args: unknown[]) => unknown;
  Tenant.prototype.hostHello = function (this: unknown, ...args: unknown[]) {
    setTimeout(() => inherited.apply(this, args), 500);
  };
  try {
    const { hostId, key } = await world.enrol(member, "eager");
    const supervisor = await world.connect(hostId, key, { boxCapacity: 1, resend: [snapshotFailed("snapshot-eager")] });
    await reads(hostId, "Online");
    supervisor.raw({ type: "Frame", seq: 3, ack: 0, message: snapshotFailed("snapshot-eager") });
    const closed = await supervisor.closed();
    assert.deepEqual(
      { code: closed.code, reason: closed.reason },
      { code: CloseCode.ProtocolError, reason: "frame gap: expected seq 2, got 3" },
    );
  } finally {
    delete Tenant.prototype.hostHello;
  }
});

test("a host whose tenant raised its frame limit streams 700 frames in a minute with none rate limited once it reconnects, while its object stays resident", async () => {
  const { hostId, key } = await world.enrol(member, "busy");
  const first = await world.connect(hostId, key, { boxCapacity: 1 });
  await reads(hostId, "Online");
  await first.closesSocket();

  const raised = await world.fetch(member, "PUT", "/v1/limits", JSON.stringify(RAISED));
  assert.equal(raised.status, 200);

  const second = await world.connect(hostId, key, { boxCapacity: 1 });
  await world.until(
    "the second connection welcomed",
    () => second.isWelcomed(),
    (welcomed) => welcomed,
  );
  for (let seq = 1; seq <= 700; seq++) second.send(snapshotFailed(`snapshot-busy-${seq}`));
  await world.settle();
  assert.deepEqual(second.rateLimited(), []);

  const third = await world.connect(hostId, key, { boxCapacity: 1 });
  await world.until(
    "the third connection welcomed",
    () => third.isWelcomed(),
    (welcomed) => welcomed,
  );
  assert.equal(third.acknowledgedSeq(), 700);
  assert.deepEqual(second.rateLimited(), []);
});

test("a staged supervisor update is stored on the host and the host read names its release and the boxes it waits on", async () => {
  const step = {
    fromSha256: "a".repeat(64),
    toSha256: "b".repeat(64),
    releaseVersion: "v0.4.2",
    boxesRunning: 2,
    phase: "Staged",
    at: "2026-11-16T12:07:00+01:00",
  };
  const supervisor = await world.online(member, "staged", { boxCapacity: 2 });
  supervisor.send({ type: "SupervisorUpdateStep", ...step });
  const stored = await world.until(
    "the staged update step reported",
    () => readHost(supervisor.hostId),
    (read) => read.supervisorUpdateStep.state !== "NotReported",
  );
  assert.deepEqual(stored.supervisorUpdateStep, { state: "Reported", step });
  assert.equal(stored.state, "Online");
  await supervisor.closesSocket();
});

test("a supervisor update failure reported before a restart is gone from host reads once the host says Hello again", async () => {
  const supervisor = await world.online(member, "stale-failure", { boxCapacity: 2 });
  supervisor.send({
    type: "SupervisorUpdateFailed",
    fromSha256: "a".repeat(64),
    toSha256: "b".repeat(64),
    reason: "SupervisorUpdateDryRunFailed",
    detail: "the candidate died with SIGFPE",
    outputTail: [],
    failedAt: "2026-11-17T14:18:00+01:00",
  });
  supervisor.send({
    type: "SupervisorUpdateStep",
    fromSha256: "a".repeat(64),
    toSha256: "c".repeat(64),
    releaseVersion: "v0.4.3",
    boxesRunning: 0,
    phase: "Restarting",
    at: "2026-11-18T08:12:00+01:00",
  });
  await world.until(
    "the failure reported",
    () => readHost(supervisor.hostId),
    (read) => read.supervisorUpdateFailure.state === "Reported",
  );
  await supervisor.closesSocket();

  const restarted = await world.reconnect(supervisor);
  const cleared = await world.until(
    "the failure cleared by the next Hello",
    () => readHost(supervisor.hostId),
    (read) => read.supervisorUpdateFailure.state === "NotReported" && read.state === "Online",
  );
  assert.deepEqual(cleared.supervisorUpdateFailure, { state: "NotReported" });
  await restarted.closesSocket();
});

test("an unknown enrolment token is refused", async () => {
  const response = await enrolWith("stranger", "x".repeat(43));
  assert.equal(response.status, 404);
  assert.equal(ProblemSchema.parse(await response.json()).code, "NotFound");
});

test("the tenant lists its open enrolment tokens without their values, and a revoked token enrols no host", async () => {
  const minted = MintedEnrolmentTokenSchema.parse(
    await (await world.fetch(member, "POST", "/v1/enrolment-tokens", JSON.stringify({ expiresInSeconds: 600 }))).json(),
  );
  assert.match(minted.token, /^[A-Za-z0-9_-]{43}$/);
  const tokenId = minted.enrolmentToken.enrolmentTokenId;
  const listed = await world.fetch(member, "GET", "/v1/enrolment-tokens");
  assert.equal(listed.status, 200);
  const body = await listed.text();
  assert.equal(body.includes(minted.token), false, "the listing carries a token value");
  assert.deepEqual(
    EnrolmentTokenSchema.array()
      .parse(JSON.parse(body))
      .filter((token) => token.enrolmentTokenId === tokenId)
      .map((token) => token.state),
    ["Unused"],
  );

  const revoke = () => world.fetch(member, "DELETE", `/v1/enrolment-tokens/${tokenId}`);
  assert.equal((await revoke()).status, 204);
  const again = await revoke();
  assert.equal(again.status, 404);
  assert.equal(ProblemSchema.parse(await again.json()).code, "NotFound");
  assert.equal(
    EnrolmentTokenSchema.array()
      .parse(await getJson("/v1/enrolment-tokens"))
      .some((token) => token.enrolmentTokenId === tokenId),
    false,
  );

  assert.equal((await enrolWith("revoked", minted.token)).status, 404);
});
