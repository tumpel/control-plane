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
  PersonaFileLimit,
  PersonaSchema,
  ProblemSchema,
  SecretSetSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { CLAUDE_CODE_VERSION } from "../../src/harness-catalog.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "../release-fixture.ts";
import { pollInterval, TEST_SETTINGS } from "../timing.ts";

type Bucket = {
  put(key: string, value: string | Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
};

const AUDIENCE = "tumpel-config-e2e";
const KID = "config-e2e-key";
const EMAIL = "config@example.test";
const SECRET = "sk-ant-e2e-never-printed";
const SECRETS_KEK = Buffer.alloc(32, 7).toString("base64");
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TUMPEL = join(ROOT, ".tmp", "release-binaries", "tumpel");
const FIXTURE = fileURLToPath(new URL("../fixtures/tenant-config.json", import.meta.url));
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
let tenant: string;

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

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

const tumpel = (args: string[], extra: Record<string, string> = {}, input = ""): Promise<Finished> => {
  const child = spawn(TUMPEL, args, {
    env: { PATH: process.env.PATH ?? "", HOME: scratch, TUMPEL_ENV_FILE: envFile, ...extra },
  });
  child.stdin.end(input);
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
    root: fileURLToPath(new URL("../..", import.meta.url)),
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          ACCESS_ISSUER: issuer,
          ACCESS_AUD: AUDIENCE,
          SECRETS_KEK,
          DASHBOARD_ORIGIN: "https://app.tumpel.test",
          R2_STUB_ORIGIN: "https://r2.example.test",
          TUMPEL_SETTINGS: TEST_SETTINGS,
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");

  const signedUp = await postJson("/v1/tenants", { name: "Config" }, browser());
  assert.equal(signedUp.status, 200);
  const { tenantId } = WhoamiSchema.parse(await signedUp.json()).tenant;
  tenant = tenantId;
  const started = DeviceAuthorizationSchema.parse(
    await (await postJson("/v1/device/code", { device_name: "config e2e" })).json(),
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

  const rotated = await tumpel(["config", "apply", file], {
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
    [["ClaudeCode", CLAUDE_CODE_VERSION]],
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

test("an apply refused at a later change writes none of the earlier ones", async () => {
  const held = await Promise.all(["/v1/personas", "/v1/secret-sets", "/v1/harnesses/pins"].map(getJson));
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const refused = await postJson(
    "/v1/tenant-config/apply",
    {
      config: {
        ...fixture,
        personas: [{ name: "Atomic", harness: "ClaudeCode", secretSetName: "atomic", connectorNames: [], files: [] }],
        secretSets: [{ ...fixture.secretSets[0], name: "atomic" }],
        harnessPins: [{ harness: "ClaudeCode", harnessVersion: "0.0.1" }],
        hosts: [],
      },
      files: [],
      secretValues: [{ env: "TUMPEL_E2E_ANTHROPIC_KEY", value: SECRET }],
      expiryValues: [],
    },
    bearer,
  );
  assert.equal(refused.status, 422);
  assert.match(ProblemSchema.parse(await refused.json()).detail, /no change was applied$/);
  const kept = await Promise.all(["/v1/personas", "/v1/secret-sets", "/v1/harnesses/pins"].map(getJson));
  assert.deepEqual(kept, held);
});

type ConfigApplier = { applyConfig(tenantId: string, writes: unknown[], now: number): Promise<{ kind: string }> };

const tenantRows = async (): Promise<Record<string, unknown[]>> => {
  const storage = await server.getWorker().getDurableObjectStorage("TENANT", { name: tenant });
  const tables = (await storage.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  )) as { name: string }[];
  const rows: Record<string, unknown[]> = {};
  for (const { name } of tables) rows[name] = await storage.exec(`SELECT * FROM "${name}" ORDER BY rowid`);
  return rows;
};

test("a write that breaks a constraint inside the apply transaction rolls back every earlier write", async () => {
  const held = await tenantRows();
  const stub = (
    await server.getWorker<{ TENANT: { getByName(name: string): ConfigApplier } }>().getEnv()
  ).TENANT.getByName(tenant);
  const secretSetId = crypto.randomUUID();
  const persona = {
    name: "Rollback",
    harness: "ClaudeCode",
    secretSetId,
    connectorIds: [],
    boxMemoryMib: 4096,
    boxDiskMib: 32768,
    files: [],
  };
  const applied = await stub.applyConfig(
    tenant,
    [
      {
        kind: "CreateSecretSet",
        secretSetId,
        secretSet: {
          name: "rollback",
          secrets: [{ kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic", value: SECRET }],
        },
        githubUser: null,
      },
      { kind: "Pin", pin: { harness: "ClaudeCode", harnessVersion: CLAUDE_CODE_VERSION } },
      { kind: "CreatePersona", persona },
      { kind: "CreatePersona", persona },
    ],
    Date.now(),
  );
  assert.equal(applied.kind, "Conflict");
  assert.deepEqual(await tenantRows(), held);
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

test("a taken name, a repeated member, two credentials for one provider and deleting a set in use are refused with 409 Conflict, and a persona on a set without a key its harness reads or an OpenRouter key on an Anthropic member with 422", async () => {
  const key = { kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic", value: SECRET };
  const created = await postJson("/v1/secret-sets", { name: "twin", secrets: [key] }, bearer);
  assert.equal(created.status, 200);
  const { secretSetId } = SecretSetSchema.parse(await created.json());
  const openRouterKey = "sk-or-v1-e2e-never-printed";
  const misfiled = await server.fetch(`${origin}/v1/secret-sets/${secretSetId}/members`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...bearer },
    body: JSON.stringify({ ...key, value: openRouterKey }),
  });
  assert.equal(misfiled.status, 422);
  const mismatch = await misfiled.text();
  assert.match(ProblemSchema.parse(JSON.parse(mismatch)).detail, /Anthropic, whose keys start with sk-ant-/);
  assert.ok(!mismatch.includes(openRouterKey));
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
    connectorIds: [],
    files: [],
  };
  assert.equal((await postJson("/v1/personas", persona, bearer)).status, 200);
  const twin = await postJson("/v1/personas", persona, bearer);
  assert.equal(twin.status, 409);
  assert.equal(ProblemSchema.parse(await twin.json()).code, "Conflict");
  const unknown = await postJson(
    "/v1/personas",
    { ...persona, name: "Lost", secretSetId: "no-such-set", connectorIds: [] },
    bearer,
  );
  assert.equal(unknown.status, 422);
  const keyless = await postJson("/v1/personas", { ...persona, name: "Keyless", harness: "Codex" }, bearer);
  assert.equal(keyless.status, 422);
  const refusal = ProblemSchema.parse(await keyless.json());
  assert.equal(refusal.code, "NoCredential");
  assert.equal(
    refusal.detail,
    "secret set twin holds no credential Codex reads: a CredentialFile for OpenAi, or a ApiKey for OpenAi, or a ApiKey for OpenRouter",
  );
  assert.equal(refusal.fix, "Add one of those to that secret set, then repeat personas.create");

  const inUse = await server.fetch(`${origin}/v1/secret-sets/${secretSetId}`, { method: "DELETE", headers: bearer });
  assert.equal(inUse.status, 409);
  assert.match(ProblemSchema.parse(await inUse.json()).detail, /Twin/);
});

test("a persona file at a path its harness does not read is refused, a stored file must be in the store, and a read returns every file's bytes", async () => {
  const [set] = SecretSetSchema.array().parse(await getJson("/v1/secret-sets"));
  assert.ok(set);
  const content = Buffer.from("{}").toString("base64");
  const base = {
    name: "Files",
    harness: "ClaudeCode",
    secretSetId: set.secretSetId,
    connectorIds: [],
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

  const large = Buffer.alloc(PersonaFileLimit.InlineFileBytes + 1, "l");
  const largeDigest = createHash("sha256").update(large).digest("hex");
  const { STORE } = await server.getWorker<{ STORE: Bucket }>().getEnv();
  await STORE.put(`${tenant}/persona-files/${largeDigest}`, large);
  const both = await put([
    { source: "Inline", path: ".claude/CLAUDE.md", content: Buffer.from(REVIEWER_MEMORY).toString("base64") },
    { source: "Stored", path: ".claude/settings.json", digest: largeDigest, sizeBytes: large.byteLength },
  ]);
  assert.equal(both.status, 200);
  const [memory, settings] = PersonaSchema.parse(await getJson(`/v1/personas/${persona.personaId}`)).files;
  assert.ok(memory?.source === "Inline");
  assert.equal(memory.content, Buffer.from(REVIEWER_MEMORY).toString("base64"));
  assert.ok(settings?.source === "Stored");
  const download = new URL(settings.downloadUrl);
  assert.equal(download.searchParams.get("X-Tumpel-Method"), "GET");
  const blob = await STORE.get(decodeURIComponent(download.pathname).replace(/^\/tumpel-sessions\//, ""));
  assert.ok(blob);
  assert.equal(
    createHash("sha256")
      .update(new Uint8Array(await blob.arrayBuffer()))
      .digest("hex"),
    settings.digest,
  );
});

test("tumpel persona get output without its server fields creates a copy with the same files, and persona list returns every file's bytes", async () => {
  const [set] = SecretSetSchema.array().parse(await getJson("/v1/secret-sets"));
  assert.ok(set);
  const large = Buffer.alloc(PersonaFileLimit.InlineFileBytes + 1, "l");
  const largeDigest = createHash("sha256").update(large).digest("hex");
  const { STORE } = await server.getWorker<{ STORE: Bucket }>().getEnv();
  await STORE.put(`${tenant}/persona-files/${largeDigest}`, large);
  const created = await postJson(
    "/v1/personas",
    {
      name: "Original",
      harness: "ClaudeCode",
      secretSetId: set.secretSetId,
      connectorIds: [],
      files: [
        { source: "Inline", path: ".claude/CLAUDE.md", content: Buffer.from(REVIEWER_MEMORY).toString("base64") },
        { source: "Stored", path: ".claude/settings.json", digest: largeDigest, sizeBytes: large.byteLength },
      ],
    },
    bearer,
  );
  assert.equal(created.status, 200);
  const { personaId } = PersonaSchema.parse(await created.json());

  const read = await tumpel(["persona", "get", personaId]);
  assert.equal(read.code, 0, read.stderr);
  const original = PersonaSchema.parse(JSON.parse(read.stdout));
  const [memory] = original.files;
  assert.ok(memory?.source === "Inline");
  assert.equal(Buffer.from(memory.content, "base64").toString(), REVIEWER_MEMORY);

  const { personaId: _id, tenantId: _tenant, createdAt: _created, updatedAt: _updated, ...written } = original;
  const copy = {
    ...written,
    name: "Copy",
    files: written.files.map((file) =>
      file.source === "Inline"
        ? { source: file.source, path: file.path, content: file.content }
        : { source: file.source, path: file.path, digest: file.digest, sizeBytes: file.sizeBytes },
    ),
  };
  const copyFile = join(scratch, "persona-copy.json");
  writeFileSync(copyFile, JSON.stringify(copy));
  const copied = await tumpel(["persona", "create", "--file", copyFile]);
  assert.equal(copied.code, 0, copied.stderr);
  assert.deepEqual(
    PersonaSchema.parse(JSON.parse(copied.stdout)).files.map((file) => [file.source, file.path, file.digest]),
    [
      ["Inline", ".claude/CLAUDE.md", sha256(REVIEWER_MEMORY)],
      ["Stored", ".claude/settings.json", largeDigest],
    ],
  );

  const listed = await tumpel(["persona", "list"]);
  assert.equal(listed.code, 0, listed.stderr);
  const [listedMemory] =
    PersonaSchema.array()
      .parse(JSON.parse(listed.stdout))
      .find((persona) => persona.personaId === personaId)?.files ?? [];
  assert.deepEqual(listedMemory, memory);
});

test("secret-set set-member writes one member from stdin and keeps the rest, and remove-member drops one", async () => {
  const created = await tumpel(["secret-set", "create", "--name", "piped"]);
  assert.equal(created.code, 0, created.stderr);
  const { secretSetId } = SecretSetSchema.parse(JSON.parse(created.stdout));
  const key = ["api-key", secretSetId, "--name", "ANTHROPIC_API_KEY", "--provider", "Anthropic"];

  const asArgument = await tumpel(["secret-set", "set-member", ...key]);
  assert.equal(asArgument.code, 1);
  assert.match(asArgument.stderr, /--stdin/);

  const keyed = await tumpel(["secret-set", "set-member", ...key, "--stdin"], {}, `${SECRET}\n`);
  assert.equal(keyed.code, 0, keyed.stderr);
  const token = ["variable", secretSetId, "--name", "DEPLOY_TOKEN"];
  const both = await tumpel(["secret-set", "set-member", ...token, "--stdin"], {}, SECRET);
  assert.equal(both.code, 0, both.stderr);
  assert.ok(!`${keyed.stdout}${keyed.stderr}${both.stdout}${both.stderr}`.includes(SECRET));
  assert.deepEqual(
    SecretSetSchema.parse(JSON.parse(both.stdout)).keys.map((member) => [member.kind, member.name]),
    [
      ["ApiKey", "ANTHROPIC_API_KEY"],
      ["Variable", "DEPLOY_TOKEN"],
    ],
  );

  writeLocal(join(scratch, "piped", "CLAUDE.md"), REVIEWER_MEMORY);
  const persona = await tumpel([
    "persona",
    "create",
    "--name",
    "Piped",
    "--harness",
    "ClaudeCode",
    "--secret-set-id",
    secretSetId,
    "--persona-file",
    `.claude/CLAUDE.md=${join(scratch, "piped", "CLAUDE.md")}`,
    "--no-connectors",
  ]);
  assert.equal(persona.code, 0, persona.stderr);
  const { personaId } = PersonaSchema.parse(JSON.parse(persona.stdout));
  const renamed = await tumpel(["persona", "update", personaId, "--name", "Piped again"]);
  assert.equal(renamed.code, 0, renamed.stderr);
  const kept = PersonaSchema.parse(JSON.parse(renamed.stdout));
  assert.deepEqual(
    [kept.name, kept.secretSetId, kept.files.map((held) => [held.path, held.digest])],
    ["Piped again", secretSetId, [[".claude/CLAUDE.md", sha256(REVIEWER_MEMORY)]]],
  );

  const removed = await tumpel(["secret-set", "remove-member", secretSetId, "ANTHROPIC_API_KEY"]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(
    SecretSetSchema.parse(JSON.parse(removed.stdout)).keys.map((member) => member.name),
    ["DEPLOY_TOKEN"],
  );
  const missing = await tumpel(["secret-set", "remove-member", secretSetId, "ANTHROPIC_API_KEY"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no member ANTHROPIC_API_KEY/);
});
