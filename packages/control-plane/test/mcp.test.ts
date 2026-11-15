import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ConfigSecretSetSchema,
  DeviceAuthorizationSchema,
  DeviceSchema,
  DeviceTokenSchema,
  EffectiveHarnessVersionSchema,
  HarnessCatalogEntrySchema,
  HarnessPinSchema,
  HostSchema,
  MintedEnrolmentTokenSchema,
  OAuthClientSchema,
  OAuthTokenSchema,
  PersonaSchema,
  ProblemSchema,
  SecretSetSchema,
  WhoamiSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import type { z } from "zod";
import { CLAUDE_CODE_AMD64_RELEASE } from "./release-fixture.ts";

type Bucket = { put(key: string, value: string): Promise<unknown> };

const AUDIENCE = "tumpel-mcp-e2e";
const KID = "mcp-e2e-key";
const EMAIL = "mcp@example.test";
const CALLBACK = "https://client.example.test/callback";
const SECRET = "sk-ant-mcp-e2e-never-shown";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;
let bearer: Record<string, string>;
let connector: string;

const assertion = (): string => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], email: EMAIL, iat: now, nbf: now, exp: now + 600 });
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`;
};

const browser = (): Record<string, string> => ({ "cf-access-jwt-assertion": assertion(), origin });
const IDENTITY = { gitAuthorName: "Ticket Worker", gitAuthorEmail: "ticket-worker@example.test" };

const call = (path: string, init: NonNullable<Parameters<TestHarness["fetch"]>[1]> = {}) =>
  server.fetch(`${origin}${path}`, { redirect: "manual", ...init });

const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const rest = async <T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<T> => {
  const response =
    body === undefined ? await call(path, { method, headers: bearer }) : await send(method, path, body, bearer);
  assert.equal(response.status, 200, `${method} ${path}`);
  return schema.parse(await response.json());
};

let nextId = 10;

const mcp = async (method: string, params: unknown): Promise<unknown> => {
  nextId += 1;
  const response = await send(
    "POST",
    "/mcp",
    { jsonrpc: "2.0", id: nextId, method, params },
    { authorization: `Bearer ${connector}` },
  );
  assert.equal(response.status, 200, method);
  return ((await response.json()) as { result: unknown }).result;
};

type ToolAnswer = { isError?: boolean; content: { text: string }[] };

const tool = async (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> =>
  (await mcp("tools/call", { name, arguments: args })) as ToolAnswer;

const toolJson = async <T>(schema: z.ZodType<T>, name: string, args: Record<string, unknown> = {}): Promise<T> => {
  const answer = await tool(name, args);
  assert.ok(!answer.isError, `${name}: ${answer.content[0]?.text}`);
  return schema.parse(JSON.parse(answer.content[0]?.text ?? ""));
};

const toolDone = async (name: string, args: Record<string, unknown>): Promise<void> => {
  const answer = await tool(name, args);
  assert.ok(!answer.isError, `${name}: ${answer.content[0]?.text}`);
};

const deviceToken = async (tenantId: string): Promise<string> => {
  const started = DeviceAuthorizationSchema.parse(
    await (await send("POST", "/v1/device/code", { device_name: "mcp e2e" })).json(),
  );
  assert.equal(
    (await send("POST", "/v1/device/approve", { userCode: started.user_code, tenantId }, browser())).status,
    200,
  );
  await new Promise((resolve) => setTimeout(resolve, started.interval * 1000 + 100));
  const granted = await send("POST", "/v1/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: started.device_code,
  });
  assert.equal(granted.status, 200);
  return DeviceTokenSchema.parse(await granted.json()).access_token;
};

const connectorToken = async (tenantId: string): Promise<string> => {
  const registered = await send("POST", "/oauth/register", { redirect_uris: [CALLBACK], client_name: "mcp e2e" });
  const client = OAuthClientSchema.parse(await registered.json());
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    state: "mcp-e2e",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const consentUrl = new URL((await call(`/oauth/authorize?${authorize}`)).headers.get("location") ?? "");
  const csrf = randomBytes(32).toString("base64url");
  const consented = await call(consentUrl.pathname, {
    method: "POST",
    headers: {
      ...browser(),
      "content-type": "application/x-www-form-urlencoded",
      cookie: `__Host-tumpel_connect=${csrf}`,
    },
    body: new URLSearchParams({
      request: consentUrl.searchParams.get("request") ?? "",
      csrf,
      tenant: tenantId,
      action: "approve",
    }).toString(),
  });
  const code = new URL(consented.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const token = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
    }).toString(),
  });
  assert.equal(token.status, 200);
  return OAuthTokenSchema.parse(await token.json()).access_token;
};

const enrolHost = async (): Promise<string> => {
  const minted = await rest(MintedEnrolmentTokenSchema, "POST", "/v1/enrolment-tokens", { expiresInSeconds: 600 });
  const raw = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x ?? "";
  const enrolled = await send("POST", "/v1/hosts/enrol", {
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
        vars: {
          ACCESS_ISSUER: issuer,
          ACCESS_AUD: AUDIENCE,
          SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
          DASHBOARD_ORIGIN: "https://app.tumpel.test",
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  const signedUp = await send("POST", "/v1/tenants", { name: "Mcp", ...IDENTITY }, browser());
  assert.equal(signedUp.status, 200);
  const { tenantId } = WhoamiSchema.parse(await signedUp.json()).tenant;
  bearer = { authorization: `Bearer ${await deviceToken(tenantId)}` };
  connector = await connectorToken(tenantId);
});

after(async () => {
  await server?.close();
  certs?.close();
});

test("every MCP tool answers what its REST operation answers, and no secret value crosses MCP", async () => {
  const listed = (await mcp("tools/list", {})) as { tools: { name: string; inputSchema: unknown }[] };
  const schemas = JSON.stringify(listed.tools);
  assert.ok(!schemas.includes('"value"'), "a tool takes a secret value");

  const hostId = await enrolHost();
  await (await server.getWorker<{ RELEASES: Bucket }>().getEnv()).RELEASES.put(
    "current.json",
    JSON.stringify(CLAUDE_CODE_AMD64_RELEASE),
  );
  assert.deepEqual(
    await toolJson(HostSchema, "tumpel_host_get", { hostId }),
    await rest(HostSchema, "GET", `/v1/hosts/${hostId}`),
  );
  const labelled = await toolJson(HostSchema, "tumpel_host_set_labels", { hostId, labels: ["gpu"] });
  assert.deepEqual(labelled.labels, ["gpu"]);
  assert.deepEqual(labelled, await rest(HostSchema, "GET", `/v1/hosts/${hostId}`));

  assert.deepEqual(
    await toolJson(HarnessCatalogEntrySchema.array(), "tumpel_harness_list"),
    await rest(HarnessCatalogEntrySchema.array(), "GET", "/v1/harnesses"),
  );
  const [entry] = await rest(HarnessCatalogEntrySchema.array(), "GET", "/v1/harnesses");
  assert.ok(entry);
  const pinned = await toolJson(HarnessPinSchema, "tumpel_harness_pin", {
    harness: entry.harness,
    harnessVersion: entry.harnessVersion,
  });
  assert.deepEqual(
    await toolJson(EffectiveHarnessVersionSchema.array(), "tumpel_harness_list_pins"),
    await rest(EffectiveHarnessVersionSchema.array(), "GET", "/v1/harnesses/pins"),
  );
  assert.deepEqual(
    (await rest(EffectiveHarnessVersionSchema.array(), "GET", "/v1/harnesses/pins")).filter((row) => row.pinned),
    [{ harness: pinned.harness, harnessVersion: pinned.harnessVersion, pinned: true }],
  );
  const unreleased = await send("PUT", "/v1/harnesses/pins", { harness: "Codex", harnessVersion: "0.50.0" }, bearer);
  assert.equal(unreleased.status, 422);
  assert.equal(ProblemSchema.parse(await unreleased.json()).code, "ImageNotReleased");
  await toolDone("tumpel_harness_unpin", { harness: entry.harness });
  assert.deepEqual(await rest(EffectiveHarnessVersionSchema.array(), "GET", "/v1/harnesses/pins"), [
    { harness: "ClaudeCode", harnessVersion: "2.0.0", pinned: false },
    { harness: "Codex", harnessVersion: "0.50.0", pinned: false },
    { harness: "OpenCode", harnessVersion: "1.0.0", pinned: false },
    { harness: "PiDev", harnessVersion: "0.10.0", pinned: false },
  ]);

  const [defaultSet] = await rest(SecretSetSchema.array(), "GET", "/v1/secret-sets");
  assert.ok(defaultSet);
  const secretSet = await rest(SecretSetSchema, "POST", "/v1/secret-sets", {
    name: "prod",
    secrets: [{ kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic", value: SECRET }],
  });
  const persona = await toolJson(PersonaSchema, "tumpel_persona_create", {
    name: "Reviewer",
    harness: "ClaudeCode",
    secretSetId: secretSet.secretSetId,
    gitAuthorName: "Reviewer",
    gitAuthorEmail: "reviewer@example.test",
    files: [{ source: "Inline", path: ".claude/CLAUDE.md", content: Buffer.from("Review").toString("base64") }],
  });
  assert.deepEqual(persona, await rest(PersonaSchema, "GET", `/v1/personas/${persona.personaId}`));
  assert.deepEqual(
    await toolJson(PersonaSchema, "tumpel_persona_get", { personaId: persona.personaId }),
    await rest(PersonaSchema, "GET", `/v1/personas/${persona.personaId}`),
  );
  const updated = await toolJson(PersonaSchema, "tumpel_persona_update", {
    personaId: persona.personaId,
    name: "Reviewer",
    secretSetId: defaultSet.secretSetId,
    gitAuthorName: "Reviewer",
    gitAuthorEmail: "reviewer@example.test",
    files: [{ source: "Inline", path: ".claude/CLAUDE.md", content: Buffer.from("Review closely").toString("base64") }],
  });
  assert.notEqual(updated.files[0]?.digest, persona.files[0]?.digest);
  assert.equal(updated.secretSetId, defaultSet.secretSetId);
  assert.deepEqual(
    await toolJson(PersonaSchema.array(), "tumpel_persona_list"),
    await rest(PersonaSchema.array(), "GET", "/v1/personas"),
  );
  await toolDone("tumpel_persona_delete", { personaId: persona.personaId });
  assert.equal((await call(`/v1/personas/${persona.personaId}`, { headers: bearer })).status, 404);

  const listedSets = await toolJson(SecretSetSchema.array(), "tumpel_secret_set_list");
  assert.deepEqual(listedSets, await rest(SecretSetSchema.array(), "GET", "/v1/secret-sets"));
  const fetchedSet = await toolJson(SecretSetSchema, "tumpel_secret_set_get", { secretSetId: secretSet.secretSetId });
  assert.deepEqual(fetchedSet, secretSet);
  assert.ok(!JSON.stringify([listedSets, fetchedSet]).includes(SECRET));

  const draft = {
    name: "staging",
    secrets: [
      { kind: "ApiKey", name: "OPENAI_API_KEY", provider: "OpenAi", valueFrom: { env: "STAGING_OPENAI_KEY" } },
      { kind: "Variable", name: "GITHUB_TOKEN", valueFrom: { env: "STAGING_GITHUB_TOKEN" } },
    ],
  };
  assert.deepEqual(await toolJson(ConfigSecretSetSchema, "tumpel_secret_set_create", draft), draft);
  assert.deepEqual(
    await toolJson(ConfigSecretSetSchema, "tumpel_secret_set_update", { secretSetId: secretSet.secretSetId, ...draft }),
    draft,
  );
  const withValue = await tool("tumpel_secret_set_create", {
    name: "leak",
    secrets: [{ ...draft.secrets[0], value: SECRET }],
  });
  assert.ok(withValue.isError);
  assert.ok(!JSON.stringify(withValue).includes(SECRET));
  assert.deepEqual(await rest(SecretSetSchema.array(), "GET", "/v1/secret-sets"), [defaultSet, secretSet]);
  await toolDone("tumpel_secret_set_delete", { secretSetId: secretSet.secretSetId });
  assert.deepEqual(await rest(SecretSetSchema.array(), "GET", "/v1/secret-sets"), [defaultSet]);

  const devices = await toolJson(DeviceSchema.array(), "tumpel_devices_list");
  assert.deepEqual(devices, await rest(DeviceSchema.array(), "GET", "/v1/devices"));
  const [device] = devices;
  assert.ok(device);
  await toolDone("tumpel_devices_revoke", { deviceId: device.deviceId });
  assert.equal((await call("/v1/whoami", { headers: bearer })).status, 401);
});
