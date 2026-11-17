import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, suite, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ChannelProtocol,
  CloseCode,
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  EnrolmentTokenSchema,
  HostSchema,
  MintedEnrolmentTokenSchema,
  ProblemSchema,
  ReportedHostUsageSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { z } from "zod";
import { ControlEnvelopeSchema, helloBytes } from "../../src/channel/protocol.ts";
import { pollInterval, TEST_SETTINGS, until } from "../timing.ts";

const AUDIENCE = "tumpel-hosts-e2e";
const KID = "hosts-e2e-key";
const EMAIL = "hosts@example.test";
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const SUPERVISOR = join(ROOT, "target", "debug", "tumpel-supervisor");
const TUMPEL = join(ROOT, "target", "debug", "tumpel");

type WorkerConfig = Extract<
  Extract<Parameters<typeof createTestHarness>[0], object>["workers"][number],
  { config: unknown }
>["config"];

const { env: _stages, ...config }: WorkerConfig & { env?: unknown } = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)), "utf8"),
);

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;
let scratch: string;
let bearer: Record<string, string>;
let accessToken: string;
let tenantId: string;
const children: ChildProcess[] = [];

const assertion = (): string => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], email: EMAIL, iat: now, nbf: now, exp: now + 600 });
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`;
};

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  server.fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const browser = (): Record<string, string> => ({ "cf-access-jwt-assertion": assertion(), origin });

const readHost = async (hostId: string) => {
  const response = await server.fetch(`${origin}/v1/hosts/${hostId}`, { headers: bearer });
  assert.equal(response.status, 200);
  return HostSchema.parse(await response.json());
};

const hostState = async (hostId: string): Promise<string> => (await readHost(hostId)).state;

const waitForState = (hostId: string, state: string) =>
  until(
    `host ${hostId} reading ${state}`,
    () => hostState(hostId),
    (read) => read === state,
  );

const USAGE = { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 1024 };

const rawHost = (hostId: string, privateKey: KeyObject, boxCapacity: number, welcomed: (socket: WebSocket) => void) => {
  const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/v1/hosts/${hostId}/channel`);
  let beat: NodeJS.Timeout | undefined;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener(
      "close",
      (event) => {
        clearInterval(beat);
        resolve({ code: event.code, reason: event.reason });
      },
      { once: true },
    );
  });
  socket.addEventListener("message", (event) => {
    const envelope = ControlEnvelopeSchema.parse(JSON.parse(String(event.data)));
    if (envelope.type === "Welcome") {
      welcomed(socket);
      beat = setInterval(
        () => socket.send(JSON.stringify({ type: "Heartbeat", sentAt: new Date().toISOString(), usage: USAGE })),
        TEST_SETTINGS.heartbeatIntervalSeconds * 1000,
      );
    }
    if (envelope.type !== "Challenge") return;
    socket.send(
      JSON.stringify({
        type: "Hello",
        hostId,
        protocolVersion: ChannelProtocol.Version,
        supervisorVersion: "0.1.0",
        signature: sign(null, helloBytes(envelope.nonce, hostId), privateKey).toString("base64"),
        boxCapacity,
        usage: USAGE,
      }),
    );
  });
  return { socket, closed };
};

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

const supervisor = (dir: string, args: string[]): { child: ChildProcess; finished: Promise<Finished> } => {
  const child = spawn(SUPERVISOR, args, { env: { ...process.env, TUMPEL_SUPERVISOR_DIR: dir } });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const finished = new Promise<Finished>((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, finished };
};

const mint = async (): Promise<string> => {
  const response = await postJson("/v1/enrolment-tokens", { expiresInSeconds: 600 }, bearer);
  assert.equal(response.status, 200);
  const minted = MintedEnrolmentTokenSchema.parse(await response.json());
  assert.equal(
    minted.installCommand,
    `curl -fL ${origin}/v1/releases/supervisor/Amd64 -o tumpel-supervisor && chmod +x tumpel-supervisor && ./tumpel-supervisor install --endpoint ${origin} --token-file -`,
  );
  return minted.token;
};

const enrol = async (name: string, token: string): Promise<{ dir: string; finished: Finished }> => {
  const dir = join(scratch, name);
  const tokenFile = join(scratch, `${name}.token`);
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const { finished } = supervisor(dir, ["enrol", "--endpoint", origin, "--token-file", tokenFile, "--name", name]);
  const done = await finished;
  if (done.code === 0) {
    const runtime = join(dir, "runtime.json");
    const written = JSON.parse(readFileSync(runtime, "utf8"));
    writeFileSync(
      runtime,
      JSON.stringify({ ...written, heartbeatIntervalSeconds: TEST_SETTINGS.heartbeatIntervalSeconds }),
    );
  }
  return { dir, finished: done };
};

before(async () => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  scratch = mkdtempSync(join(ROOT, ".tmp", "hosts-e2e-"));
  certs = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => certs.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(certs.address() as AddressInfo).port}`;
  server = createTestHarness({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    workers: [
      {
        config: {
          ...config,
          main: "./test/fixtures/slow-hello-worker.ts",
          vars: {
            ...config.vars,
            TUMPEL_SETTINGS: TEST_SETTINGS,
            ACCESS_ISSUER: issuer,
            ACCESS_AUD: AUDIENCE,
            SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
            DASHBOARD_ORIGIN: "https://app.tumpel.test",
          },
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");

  const signedUp = await postJson("/v1/tenants", { name: "Hosts" }, browser());
  assert.equal(signedUp.status, 200);
  tenantId = WhoamiSchema.parse(await signedUp.json()).tenant.tenantId;
  const started = DeviceAuthorizationSchema.parse(
    await (await postJson("/v1/device/code", { device_name: "hosts e2e" })).json(),
  );
  assert.equal(
    (await postJson("/v1/device/approve", { userCode: started.user_code, tenantId }, browser())).status,
    200,
  );
  await pollInterval(started.interval);
  const granted = await postJson("/v1/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: started.device_code,
  });
  assert.equal(granted.status, 200);
  accessToken = DeviceTokenSchema.parse(await granted.json()).access_token;
  bearer = { authorization: `Bearer ${accessToken}` };
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  await server?.close();
  certs?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

suite("hosts", { concurrency: true }, () => {
  test("a host enrols with a one-time token, holds its channel, drops to Offline when it falls silent, and stops on revoke", async () => {
    const token = await mint();
    const first = await enrol("first", token);
    assert.equal(first.finished.code, 0, first.finished.stderr);
    const host = HostSchema.parse(JSON.parse(first.finished.stdout));
    assert.equal(host.state, "Enrolled");
    assert.equal(host.name, "first");
    for (const file of ["supervisor.json", "host-key.json", "channel.json"]) {
      assert.equal(statSync(join(first.dir, file)).mode & 0o777, 0o600, file);
    }

    const second = await enrol("second", token);
    assert.equal(second.finished.code, 1);
    assert.match(second.finished.stderr, /Enrolment token spent/);

    const running = supervisor(first.dir, ["run"]);
    await waitForState(host.hostId, "Online");
    const listed = await server.fetch(`${origin}/v1/hosts`, { headers: bearer });
    assert.deepEqual(
      HostSchema.array()
        .parse(await listed.json())
        .filter((row) => row.hostId === host.hostId)
        .map((row) => row.state),
      ["Online"],
    );

    running.child.kill("SIGSTOP");
    await waitForState(host.hostId, "Offline");
    running.child.kill("SIGCONT");
    await waitForState(host.hostId, "Online");
    const revoked = await postJson(`/v1/hosts/${host.hostId}/revoke`, {}, bearer);
    assert.equal(revoked.status, 200);
    assert.equal(HostSchema.parse(await revoked.json()).state, "Revoked");
    const stopped = await running.finished;
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stderr, /was revoked/);
    assert.equal(existsSync(join(first.dir, "host-key.json")), false);
    assert.equal(await hostState(host.hostId), "Revoked");
    const usage = await server.fetch(`${origin}/v1/hosts/usage`, { headers: bearer });
    assert.deepEqual(
      ReportedHostUsageSchema.array()
        .parse(await usage.json())
        .filter((row) => row.hostId === host.hostId),
      [],
    );

    const afterRevoke = await supervisor(first.dir, ["run"]).finished;
    assert.equal(afterRevoke.code, 5);
    assert.match(afterRevoke.stderr, /HostRevoked/);
  });

  test("a running supervisor's host samples land in its tenant's metrics store under its signed host id", async () => {
    const enrolled = await enrol("telemetry", await mint());
    assert.equal(enrolled.finished.code, 0, enrolled.finished.stderr);
    const { hostId } = HostSchema.parse(JSON.parse(enrolled.finished.stdout));
    supervisor(enrolled.dir, ["run"]);
    const SeriesSchema = z.array(z.object({ metric: z.string(), dimensions: z.string() }));
    await until(
      `host ${hostId}'s host.memory.total reaching the metrics store`,
      async () => SeriesSchema.parse(await (await server.fetch(`${origin}/__fixture/metrics/${tenantId}`)).json()),
      (series) =>
        series.some(
          ({ metric, dimensions }) => metric === "host.memory.total" && JSON.parse(dimensions).hostId === hostId,
        ),
    );
  });

  test("a supervisor whose channel state is gone exits with ChannelStateLost", async () => {
    const enrolled = await enrol("lost", await mint());
    assert.equal(enrolled.finished.code, 0, enrolled.finished.stderr);
    unlinkSync(join(enrolled.dir, "channel.json"));
    const finished = await supervisor(enrolled.dir, ["run"]).finished;
    assert.equal(finished.code, 4);
    assert.match(finished.stderr, /ChannelStateLost/);
  });

  test("a frame the host sends the moment Welcome arrives is accepted while the tenant's hostHello is still in flight", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = Buffer.from(keys.publicKey.export({ format: "jwk" }).x ?? "", "base64url").toString("base64");
    const enrolled = await postJson("/v1/hosts/enrol", {
      name: "eager",
      architecture: "Amd64",
      cpuCount: 1,
      memoryBytes: 1024,
      publicKey,
      supervisorVersion: "0.1.0",
      enrolmentToken: await mint(),
    });
    assert.equal(enrolled.status, 200);
    const { hostId } = HostSchema.parse(await enrolled.json());

    const frame = (seq: number): string =>
      JSON.stringify({
        type: "Frame",
        seq,
        ack: 0,
        message: {
          type: "SnapshotFailed",
          snapshotId: "snapshot-eager",
          reason: "BoxNotFound",
          detail: "no box",
          failedAt: "2026-11-15T10:00:00+01:00",
        },
      });
    const { socket, closed } = rawHost(hostId, keys.privateKey, 1, (welcomed) => welcomed.send(frame(1)));

    await waitForState(hostId, "Online");
    socket.send(frame(3));
    assert.deepEqual(await closed, { code: CloseCode.ProtocolError, reason: "frame gap: expected seq 2, got 3" });
  });

  test("a staged supervisor update is stored on the host and tumpel host get names its release and the boxes it waits on", async () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = Buffer.from(keys.publicKey.export({ format: "jwk" }).x ?? "", "base64url").toString("base64");
    const enrolled = await postJson("/v1/hosts/enrol", {
      name: "staged",
      architecture: "Amd64",
      cpuCount: 1,
      memoryBytes: 1024,
      publicKey,
      supervisorVersion: "0.1.0",
      enrolmentToken: await mint(),
    });
    assert.equal(enrolled.status, 200);
    const { hostId } = HostSchema.parse(await enrolled.json());
    const step = {
      fromSha256: "a".repeat(64),
      toSha256: "b".repeat(64),
      releaseVersion: "v0.4.2",
      boxesRunning: 2,
      phase: "Staged",
      at: "2026-11-16T12:07:00+01:00",
    };
    const { socket } = rawHost(hostId, keys.privateKey, 2, (welcomed) =>
      welcomed.send(
        JSON.stringify({ type: "Frame", seq: 1, ack: 0, message: { type: "SupervisorUpdateStep", ...step } }),
      ),
    );

    const stored = await until(
      "the staged update step reported",
      () => readHost(hostId),
      (read) => read.supervisorUpdateStep.state !== "NotReported",
    );
    assert.deepEqual(stored.supervisorUpdateStep, { state: "Reported", step });
    assert.equal(stored.state, "Online");
    socket.close();

    const envFile = join(scratch, "staged.env");
    writeFileSync(envFile, `TUMPEL_ENDPOINT=${origin}\nTUMPEL_TOKEN=${accessToken}\n`, { mode: 0o600 });
    const child = spawn(TUMPEL, ["host", "get", hostId], {
      env: { PATH: process.env.PATH ?? "", HOME: scratch, TUMPEL_ENV_FILE: envFile },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    assert.deepEqual(HostSchema.parse(JSON.parse(stdout)).supervisorUpdateStep, { state: "Reported", step });
    assert.match(stderr, /Update to v0\.4\.2 staged, waiting for 2 boxes/);
  });

  test("an unknown enrolment token is refused", async () => {
    const response = await postJson("/v1/hosts/enrol", {
      name: "stranger",
      architecture: "Amd64",
      cpuCount: 1,
      memoryBytes: 1024,
      publicKey: Buffer.alloc(32).toString("base64"),
      supervisorVersion: "0.1.0",
      enrolmentToken: "x".repeat(43),
    });
    assert.equal(response.status, 404);
    assert.equal(ProblemSchema.parse(await response.json()).code, "NotFound");
  });

  test("the tenant lists its open enrolment tokens without their values, and a revoked token enrols no host", async () => {
    const minted = MintedEnrolmentTokenSchema.parse(
      await (await postJson("/v1/enrolment-tokens", { expiresInSeconds: 600 }, bearer)).json(),
    );
    const tokenId = minted.enrolmentToken.enrolmentTokenId;
    const listed = await server.fetch(`${origin}/v1/enrolment-tokens`, { headers: bearer });
    assert.equal(listed.status, 200);
    const body = await listed.text();
    assert.equal(body.includes(minted.token), false, "the listing carries a token value");
    const open = EnrolmentTokenSchema.array().parse(JSON.parse(body));
    assert.deepEqual(
      open.filter((token) => token.enrolmentTokenId === tokenId).map((token) => token.state),
      ["Unused"],
    );

    const revoke = () =>
      server.fetch(`${origin}/v1/enrolment-tokens/${tokenId}`, { method: "DELETE", headers: bearer });
    assert.equal((await revoke()).status, 204);
    const again = await revoke();
    assert.equal(again.status, 404);
    assert.equal(ProblemSchema.parse(await again.json()).code, "NotFound");
    const remaining = EnrolmentTokenSchema.array().parse(
      await (await server.fetch(`${origin}/v1/enrolment-tokens`, { headers: bearer })).json(),
    );
    assert.equal(
      remaining.some((token) => token.enrolmentTokenId === tokenId),
      false,
    );

    const enrol = await postJson("/v1/hosts/enrol", {
      name: "revoked",
      architecture: "Amd64",
      cpuCount: 1,
      memoryBytes: 1024,
      publicKey: Buffer.alloc(32).toString("base64"),
      supervisorVersion: "0.1.0",
      enrolmentToken: minted.token,
    });
    assert.equal(enrol.status, 404);
  });

  test("tumpel host mint-token prints the token to stdout only, and its install hint reads the token from stdin", async () => {
    const envFile = join(scratch, "cli.env");
    writeFileSync(envFile, `TUMPEL_ENDPOINT=${origin}\nTUMPEL_TOKEN=${accessToken}\n`, { mode: 0o600 });
    const child = spawn(TUMPEL, ["host", "mint-token", "--expires-in", "600"], {
      env: { PATH: process.env.PATH ?? "", HOME: scratch, TUMPEL_ENV_FILE: envFile },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    const token = stdout.trim();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(stderr.includes(token), false, "stderr carries the enrolment token");
    assert.match(stderr, /\.\/tumpel-supervisor install --endpoint \S+ --token-file -/);
  });
});
