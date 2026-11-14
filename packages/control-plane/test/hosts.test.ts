import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  HostSchema,
  MintedEnrolmentTokenSchema,
  ProblemSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { HEARTBEAT_DEADLINE_MS } from "../src/channel/protocol.ts";

const AUDIENCE = "tumpel-hosts-e2e";
const KID = "hosts-e2e-key";
const EMAIL = "hosts@example.test";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SUPERVISOR = join(ROOT, "target", "debug", "tumpel-supervisor");

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;
let scratch: string;
let bearer: Record<string, string>;
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const hostState = async (hostId: string): Promise<string> => {
  const response = await server.fetch(`${origin}/v1/hosts/${hostId}`, { headers: bearer });
  assert.equal(response.status, 200);
  return HostSchema.parse(await response.json()).state;
};

const waitForState = async (hostId: string, state: string, withinMs: number): Promise<number> => {
  const started = Date.now();
  while (Date.now() - started < withinMs) {
    if ((await hostState(hostId)) === state) return Date.now() - started;
    await sleep(200);
  }
  assert.fail(`host ${hostId} did not read ${state} within ${withinMs} ms; it reads ${await hostState(hostId)}`);
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
  assert.match(minted.installCommand, /^tumpel-supervisor enrol --endpoint http/);
  return minted.token;
};

const enrol = async (name: string, token: string): Promise<{ dir: string; finished: Finished }> => {
  const dir = join(scratch, name);
  const tokenFile = join(scratch, `${name}.token`);
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const { finished } = supervisor(dir, ["enrol", "--endpoint", origin, "--token-file", tokenFile, "--name", name]);
  return { dir, finished: await finished };
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
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [{ configPath: "./wrangler.jsonc", vars: { ACCESS_ISSUER: issuer, ACCESS_AUD: AUDIENCE } }],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");

  assert.equal((await postJson("/v1/tenants", { name: "Hosts" }, browser())).status, 200);
  const started = DeviceAuthorizationSchema.parse(
    await (await postJson("/v1/device/code", { device_name: "hosts e2e" })).json(),
  );
  assert.equal((await postJson("/v1/device/approve", { userCode: started.user_code }, browser())).status, 200);
  await sleep(started.interval * 1000 + 100);
  const granted = await postJson("/v1/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: started.device_code,
  });
  assert.equal(granted.status, 200);
  bearer = { authorization: `Bearer ${DeviceTokenSchema.parse(await granted.json()).access_token}` };
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  await server?.close();
  certs?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("a host enrols with a one-time token, holds its channel, drops to Offline when killed, and stops on revoke", async () => {
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
  await waitForState(host.hostId, "Online", 15_000);
  const listed = await server.fetch(`${origin}/v1/hosts`, { headers: bearer });
  assert.deepEqual(
    HostSchema.array()
      .parse(await listed.json())
      .map((row) => [row.hostId, row.state]),
    [[host.hostId, "Online"]],
  );

  running.child.kill("SIGKILL");
  await running.finished;
  await waitForState(host.hostId, "Offline", HEARTBEAT_DEADLINE_MS);

  const again = supervisor(first.dir, ["run"]);
  await waitForState(host.hostId, "Online", 15_000);
  const revoked = await postJson(`/v1/hosts/${host.hostId}/revoke`, {}, bearer);
  assert.equal(revoked.status, 200);
  assert.equal(HostSchema.parse(await revoked.json()).state, "Revoked");
  const stopped = await Promise.race([again.finished, sleep(10_000).then(() => null)]);
  assert.ok(stopped, "the supervisor did not stop within 10 s of the revoke");
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match(stopped.stderr, /was revoked/);
  assert.equal(existsSync(join(first.dir, "host-key.json")), false);
  assert.equal(await hostState(host.hostId), "Revoked");

  const afterRevoke = await supervisor(first.dir, ["run"]).finished;
  assert.equal(afterRevoke.code, 5);
  assert.match(afterRevoke.stderr, /HostRevoked/);
});

test("a supervisor whose channel state is gone exits with ChannelStateLost", async () => {
  const enrolled = await enrol("lost", await mint());
  assert.equal(enrolled.finished.code, 0, enrolled.finished.stderr);
  unlinkSync(join(enrolled.dir, "channel.json"));
  const finished = await supervisor(enrolled.dir, ["run"]).finished;
  assert.equal(finished.code, 4);
  assert.match(finished.stderr, /ChannelStateLost/);
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
