import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  EffectiveHarnessVersionSchema,
  HostSchema,
  MintedEnrolmentTokenSchema,
  PersonaSchema,
  ProblemSchema,
  SecretSetSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { CLAUDE_CODE_AMD64_RELEASE } from "./release-fixture.ts";

type Bucket = { put(key: string, value: string): Promise<unknown> };

const AUDIENCE = "tumpel-config-e2e";
const KID = "config-e2e-key";
const EMAIL = "config@example.test";
const SECRET = "sk-ant-e2e-never-printed";
const SECRETS_KEK = Buffer.alloc(32, 7).toString("base64");
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TUMPEL = join(ROOT, "target", "debug", "tumpel");
const FIXTURE = fileURLToPath(new URL("fixtures/tenant-config.json", import.meta.url));
const REVIEWER_MEMORY = "Review the diff for correctness.\n";
const REVIEWER_SETTINGS = '{"permissions":{"defaultMode":"bypassPermissions"}}\n';
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const writeLocal = (path: string, text: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

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
const IDENTITY = { gitAuthorName: "Ticket Worker", gitAuthorEmail: "ticket-worker@example.test" };

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
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: { ACCESS_ISSUER: issuer, ACCESS_AUD: AUDIENCE, SECRETS_KEK, DASHBOARD_ORIGIN: "https://app.tumpel.test" },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");

  assert.equal((await postJson("/v1/tenants", { name: "Config", ...IDENTITY }, browser())).status, 200);
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
  await (await server.getWorker<{ RELEASES: Bucket }>().getEnv()).RELEASES.put(
    "current.json",
    JSON.stringify(CLAUDE_CODE_AMD64_RELEASE),
  );
  const file = join(scratch, "tumpel.json");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  writeFileSync(file, JSON.stringify({ ...fixture, hosts: [{ hostId, labels: ["gpu", "region-eu"] }] }));
  writeLocal(join(scratch, "reviewer", "CLAUDE.md"), REVIEWER_MEMORY);
  writeLocal(join(scratch, "reviewer", "settings.json"), REVIEWER_SETTINGS);

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
      "create secret set",
      "create persona Reviewer",
      "delete persona Default",
      "delete secret set",
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
    personas.map((persona) => [persona.name, persona.harness, persona.files.map((held) => [held.path, held.digest])]),
    [
      [
        "Reviewer",
        "ClaudeCode",
        [
          [".claude/CLAUDE.md", sha256(REVIEWER_MEMORY)],
          [".claude/settings.json", sha256(REVIEWER_SETTINGS)],
        ],
      ],
    ],
  );

  writeLocal(join(scratch, "reviewer", "CLAUDE.md"), "Review closely.\n");
  const edited = await tumpel(["config", "plan", file]);
  assert.equal(edited.code, 0, edited.stderr);
  assert.match(edited.stdout, /files: write \.claude\/CLAUDE\.md \(\d+ bytes, sha256 [0-9a-f]{64}\)$/m);
  assert.doesNotMatch(edited.stdout, /settings\.json/);
  writeLocal(join(scratch, "reviewer", "CLAUDE.md"), REVIEWER_MEMORY);
  const sets = SecretSetSchema.array().parse(await getJson("/v1/secret-sets"));
  assert.deepEqual(
    sets.map((set) => [set.name, set.keys.map((key) => [key.kind, key.name])]),
    [["prod", [["ApiKey", "ANTHROPIC_API_KEY"]]]],
  );
  assert.ok(!JSON.stringify(sets).includes(SECRET));
  const versions = EffectiveHarnessVersionSchema.array().parse(await getJson("/v1/harnesses/pins"));
  assert.deepEqual(
    versions.filter((row) => row.pinned).map((pin) => [pin.harness, pin.harnessVersion]),
    [["ClaudeCode", "2.0.0"]],
  );
  assert.deepEqual(HostSchema.parse(await getJson(`/v1/hosts/${hostId}`)).labels, ["gpu", "region-eu"]);

  const started = join(scratch, "started.json");
  const initialised = await tumpel(["config", "init", started]);
  assert.equal(initialised.code, 0, initialised.stderr);
  writeLocal(join(scratch, "persona-files", "Reviewer", ".claude", "CLAUDE.md"), REVIEWER_MEMORY);
  writeLocal(join(scratch, "persona-files", "Reviewer", ".claude", "settings.json"), REVIEWER_SETTINGS);
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

test("a taken name, a repeated member, two credentials for one provider and deleting a set in use are refused with 409 Conflict", async () => {
  const key = { kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic", value: SECRET };
  const created = await postJson("/v1/secret-sets", { name: "twin", secrets: [key] }, bearer);
  assert.equal(created.status, 200);
  const { secretSetId } = SecretSetSchema.parse(await created.json());
  const taken = await postJson("/v1/secret-sets", { name: "twin", secrets: [key] }, bearer);
  assert.equal(taken.status, 409);
  assert.equal(ProblemSchema.parse(await taken.json()).code, "Conflict");
  const repeated = await postJson("/v1/secret-sets", { name: "repeated", secrets: [key, key] }, bearer);
  assert.equal(repeated.status, 409);
  assert.equal(ProblemSchema.parse(await repeated.json()).title, "Repeated member");
  const token = { ...key, kind: "SubscriptionToken", name: "CLAUDE_TOKEN", expiresAt: "2026-12-01T00:00:00+01:00" };
  const doubled = await postJson("/v1/secret-sets", { name: "doubled", secrets: [key, token] }, bearer);
  assert.equal(doubled.status, 409);
  assert.equal(ProblemSchema.parse(await doubled.json()).title, "Two credentials for one provider");
  const sets = SecretSetSchema.array().parse(await getJson("/v1/secret-sets"));
  assert.ok(!sets.some((set) => set.name === "repeated" || set.name === "doubled"));

  const persona = {
    name: "Twin",
    harness: "ClaudeCode",
    secretSetId,
    gitAuthorName: "Tumpel Agent",
    gitAuthorEmail: "agent@tumpel.invalid",
    files: [],
  };
  assert.equal((await postJson("/v1/personas", persona, bearer)).status, 200);
  const twin = await postJson("/v1/personas", persona, bearer);
  assert.equal(twin.status, 409);
  assert.equal(ProblemSchema.parse(await twin.json()).code, "Conflict");
  const unknown = await postJson("/v1/personas", { ...persona, name: "Lost", secretSetId: "no-such-set" }, bearer);
  assert.equal(unknown.status, 422);

  const inUse = await server.fetch(`${origin}/v1/secret-sets/${secretSetId}`, { method: "DELETE", headers: bearer });
  assert.equal(inUse.status, 409);
  assert.match(ProblemSchema.parse(await inUse.json()).detail, /Twin/);
});

test("a persona file at a path its harness does not read is refused, and a stored file must be in the store", async () => {
  const [set] = SecretSetSchema.array().parse(await getJson("/v1/secret-sets"));
  assert.ok(set);
  const content = Buffer.from("{}").toString("base64");
  const base = {
    name: "Files",
    harness: "ClaudeCode",
    secretSetId: set.secretSetId,
    gitAuthorName: "Tumpel Agent",
    gitAuthorEmail: "agent@tumpel.invalid",
  };
  const misplaced = await postJson(
    "/v1/personas",
    { ...base, files: [{ source: "Inline", path: ".bashrc", content }] },
    bearer,
  );
  assert.equal(misplaced.status, 422);
  assert.match(ProblemSchema.parse(await misplaced.json()).detail, /\.bashrc.*accepts \.claude\/settings\.json/);

  const created = await postJson(
    "/v1/personas",
    { ...base, files: [{ source: "Inline", path: ".claude/settings.json", content }] },
    bearer,
  );
  assert.equal(created.status, 200);
  const persona = PersonaSchema.parse(await created.json());
  const [held] = persona.files;
  assert.ok(held);
  assert.equal(held.digest, sha256("{}"));
  const put = (files: unknown[]) =>
    server.fetch(`${origin}/v1/personas/${persona.personaId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...bearer },
      body: JSON.stringify({ ...base, files }),
    });
  const kept = await put([
    { source: "Stored", path: ".claude/CLAUDE.md", digest: held.digest, sizeBytes: held.sizeBytes },
  ]);
  assert.equal(kept.status, 200);
  assert.deepEqual(
    PersonaSchema.parse(await kept.json()).files.map((file) => [file.path, file.digest]),
    [[".claude/CLAUDE.md", held.digest]],
  );
  const missing = await put([{ source: "Stored", path: ".claude/CLAUDE.md", digest: "f".repeat(64), sizeBytes: 2 }]);
  assert.equal(missing.status, 422);
  assert.equal(ProblemSchema.parse(await missing.json()).title, "Persona file not uploaded");
});
