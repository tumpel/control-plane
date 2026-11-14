import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  HarnessPinSchema,
  HostSchema,
  MintedEnrolmentTokenSchema,
  PersonaSchema,
  ProblemSchema,
  SecretSetSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";

const AUDIENCE = "tumpel-config-e2e";
const KID = "config-e2e-key";
const EMAIL = "config@example.test";
const SECRET = "sk-ant-e2e-never-printed";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TUMPEL = join(ROOT, "target", "debug", "tumpel");
const FIXTURE = fileURLToPath(new URL("fixtures/tenant-config.json", import.meta.url));

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;
let scratch: string;
let bearer: Record<string, string>;
let envFile: string;

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

const getJson = async (path: string): Promise<unknown> => {
  const response = await server.fetch(`${origin}${path}`, { headers: bearer });
  assert.equal(response.status, 200, path);
  return response.json();
};

const browser = (): Record<string, string> => ({ "cf-access-jwt-assertion": assertion(), origin });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

const tumpel = (args: string[], extra: Record<string, string> = {}): Promise<Finished> => {
  const child = spawn(TUMPEL, args, {
    env: { PATH: process.env.PATH ?? "", HOME: scratch, TUMPEL_ENV_FILE: envFile, ...extra },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
};

const enrolHost = async (): Promise<string> => {
  const minted = MintedEnrolmentTokenSchema.parse(
    await (await postJson("/v1/enrolment-tokens", { expiresInSeconds: 600 }, bearer)).json(),
  );
  const raw = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x ?? "";
  const enrolled = await postJson("/v1/hosts/enrol", {
    enrolmentToken: minted.token,
    name: "builder",
    architecture: "Amd64",
    cpuCount: 4,
    memoryBytes: 8_000_000_000,
    publicKey: Buffer.from(raw, "base64url").toString("base64"),
    supervisorVersion: "0.1.0",
  });
  assert.equal(enrolled.status, 200);
  return HostSchema.parse(await enrolled.json()).hostId;
};

before(async () => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  scratch = mkdtempSync(join(ROOT, ".tmp", "config-e2e-"));
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

  assert.equal((await postJson("/v1/tenants", { name: "Config" }, browser())).status, 200);
  const started = DeviceAuthorizationSchema.parse(
    await (await postJson("/v1/device/code", { device_name: "config e2e" })).json(),
  );
  assert.equal((await postJson("/v1/device/approve", { userCode: started.user_code }, browser())).status, 200);
  await sleep(started.interval * 1000 + 100);
  const granted = await postJson("/v1/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: started.device_code,
  });
  assert.equal(granted.status, 200);
  const token = DeviceTokenSchema.parse(await granted.json()).access_token;
  bearer = { authorization: `Bearer ${token}` };
  envFile = join(scratch, "env");
  writeFileSync(envFile, `TUMPEL_ENDPOINT=${origin}\nTUMPEL_TOKEN=${token}\n`, { mode: 0o600 });
});

after(async () => {
  await server?.close();
  certs?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("tumpel config apply makes the tenant match the file, and a second plan is empty", async () => {
  const hostId = await enrolHost();
  const file = join(scratch, "tumpel.json");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  writeFileSync(file, JSON.stringify({ ...fixture, hosts: [{ hostId, labels: ["gpu", "region-eu"] }] }));

  const validated = await tumpel(["config", "validate", file]);
  assert.equal(validated.code, 0, validated.stderr);

  const unset = await tumpel(["config", "apply", file]);
  assert.equal(unset.code, 1);
  assert.match(unset.stderr, /TUMPEL_E2E_ANTHROPIC_KEY/);

  const applied = await tumpel(["config", "apply", file], { TUMPEL_E2E_ANTHROPIC_KEY: SECRET });
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(
    applied.stdout
      .trim()
      .split("\n")
      .map((line) => line.split(" ").slice(0, 3).join(" ")),
    [
      "create persona Reviewer",
      "delete persona Default",
      "create secret set",
      "create pin ClaudeCode",
      `update host ${hostId}`,
    ],
  );
  assert.ok(!`${applied.stdout}${applied.stderr}`.includes(SECRET));

  const planned = await tumpel(["config", "plan", file]);
  assert.equal(planned.code, 0, planned.stderr);
  assert.equal(planned.stdout.trim(), "no changes; the tenant matches the file");

  const rotated = await tumpel(["config", "apply", file, "--rewrite-secrets", "prod"], {
    TUMPEL_E2E_ANTHROPIC_KEY: `${SECRET}-rotated`,
  });
  assert.equal(rotated.code, 0, rotated.stderr);
  assert.match(rotated.stdout.trim(), /^rewrite secret set prod \(/);

  const personas = PersonaSchema.array().parse(await getJson("/v1/personas"));
  assert.deepEqual(
    personas.map((persona) => [persona.name, persona.settings, persona.mcpServers]),
    [["Reviewer", '{"permissions":"bypass"}', [{ label: "docs", url: "https://docs.example.test/mcp" }]]],
  );
  const sets = SecretSetSchema.array().parse(await getJson("/v1/secret-sets"));
  assert.deepEqual(
    sets.map((set) => [set.name, set.keys.map((key) => [key.name, key.provider])]),
    [["prod", [["ANTHROPIC_API_KEY", "Anthropic"]]]],
  );
  assert.ok(!JSON.stringify(sets).includes(SECRET));
  const pins = HarnessPinSchema.array().parse(await getJson("/v1/harnesses/pins"));
  assert.deepEqual(
    pins.map((pin) => [pin.harness, pin.harnessVersion]),
    [["ClaudeCode", "2.0.0"]],
  );
  assert.deepEqual(HostSchema.parse(await getJson(`/v1/hosts/${hostId}`)).labels, ["gpu", "region-eu"]);

  const started = join(scratch, "started.json");
  const initialised = await tumpel(["config", "init", started]);
  assert.equal(initialised.code, 0, initialised.stderr);
  const replanned = await tumpel(["config", "plan", started]);
  assert.equal(replanned.stdout.trim(), "no changes; the tenant matches the file", replanned.stderr);
});

test("tumpel config validate names every key that breaks the schema, a pasted secret value among them", async () => {
  const file = join(scratch, "broken.json");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  fixture.secretSets[0].secrets[0].value = SECRET;
  delete fixture.hosts;
  writeFileSync(file, JSON.stringify(fixture));
  const validated = await tumpel(["config", "validate", file]);
  assert.equal(validated.code, 1);
  assert.match(validated.stderr, /\/secretSets\/0\/secrets\/0: .*value/);
  assert.match(validated.stderr, /\/: .*hosts/);
  assert.ok(!validated.stderr.includes(SECRET));
});

test("a name the tenant already uses and a repeated key are refused with 409 Conflict", async () => {
  const persona = { name: "Twin", instructions: "", settings: "{}", mcpServers: [] };
  assert.equal((await postJson("/v1/personas", persona, bearer)).status, 200);
  const twin = await postJson("/v1/personas", persona, bearer);
  assert.equal(twin.status, 409);
  assert.equal(ProblemSchema.parse(await twin.json()).code, "Conflict");

  const key = { name: "ANTHROPIC_API_KEY", provider: "Anthropic", value: SECRET };
  assert.equal((await postJson("/v1/secret-sets", { name: "twin", secrets: [key] }, bearer)).status, 200);
  const taken = await postJson("/v1/secret-sets", { name: "twin", secrets: [key] }, bearer);
  assert.equal(taken.status, 409);
  assert.equal(ProblemSchema.parse(await taken.json()).code, "Conflict");
  const repeated = await postJson("/v1/secret-sets", { name: "repeated", secrets: [key, key] }, bearer);
  assert.equal(repeated.status, 409);
  assert.equal(ProblemSchema.parse(await repeated.json()).title, "Repeated key");
  const sets = SecretSetSchema.array().parse(await getJson("/v1/secret-sets"));
  assert.ok(!sets.some((set) => set.name === "repeated"));
});
