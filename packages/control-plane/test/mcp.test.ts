import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ConfigSecretSetSchema,
  ConnectorSchema,
  DeviceAuthorizationSchema,
  DeviceSchema,
  DeviceTokenSchema,
  EffectiveHarnessVersionSchema,
  HarnessCatalogEntrySchema,
  HarnessPinSchema,
  HostSchema,
  MetricCatalogSchema,
  MintedEnrolmentTokenSchema,
  OAuthClientSchema,
  OAuthTokenSchema,
  PersonaSchema,
  ProblemSchema,
  SecretSetSchema,
  StoredPersonaSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import type { z } from "zod";
import { CLAUDE_CODE_VERSION } from "../src/harness-catalog.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "./release-fixture.ts";
import { pollInterval, TEST_SETTINGS } from "./timing.ts";

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
  await pollInterval(started.interval);
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
          TUMPEL_SETTINGS: TEST_SETTINGS,
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
  const signedUp = await send("POST", "/v1/tenants", { name: "Mcp" }, browser());
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
  const relabelled = await toolJson(HostSchema, "tumpel_host_patch_labels", {
    hostId,
    add: ["arm", "gpu"],
    remove: ["ssd"],
  });
  assert.deepEqual(relabelled.labels, ["gpu", "arm"]);
  const unlabelled = await toolJson(HostSchema, "tumpel_host_patch_labels", { hostId, remove: ["gpu"] });
  assert.deepEqual(unlabelled.labels, ["arm"]);

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
  const unreleased = await send("PUT", "/v1/harnesses/pins", { harness: "Codex", harnessVersion: "0.169.0" }, bearer);
  assert.equal(unreleased.status, 422);
  assert.equal(ProblemSchema.parse(await unreleased.json()).code, "ImageNotReleased");
  await toolDone("tumpel_harness_unpin", { harness: entry.harness });
  assert.deepEqual(await rest(EffectiveHarnessVersionSchema.array(), "GET", "/v1/harnesses/pins"), [
    { harness: "ClaudeCode", harnessVersion: CLAUDE_CODE_VERSION, pinned: false },
    { harness: "Codex", harnessVersion: "0.169.0", pinned: false },
    { harness: "OpenCode", harnessVersion: "1.19.5", pinned: false },
    { harness: "PiDev", harnessVersion: "1.5.2", pinned: false },
  ]);

  const window = { from: "2026-11-16T00:00:00+02:00", to: "2026-11-17T00:00:00+02:00" };
  const windowQuery = new URLSearchParams({ ...window });
  windowQuery.append("filter", "harness:Pi");
  windowQuery.append("filter", "harness:Codex");
  assert.deepEqual(
    await toolJson(MetricCatalogSchema, "tumpel_metrics_catalog", {
      ...window,
      filter: ["harness:Pi", "harness:Codex"],
    }),
    await rest(MetricCatalogSchema, "GET", `/v1/metrics?${windowQuery}`),
  );
  const unknownMetric = await call(`/v1/metrics/turn.nope/series?${windowQuery}&bucket=Hour`, { headers: bearer });
  assert.equal(unknownMetric.status, 404);
  assert.equal(ProblemSchema.parse(await unknownMetric.json()).code, "MetricNotFound");
  assert.ok((await tool("tumpel_metrics_query", { metric: "turn.nope", ...window, bucket: "Hour" })).isError);

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
    connectorIds: [],
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
    secretSetId: secretSet.secretSetId,
    connectorIds: [],
    files: [{ source: "Inline", path: ".claude/CLAUDE.md", content: Buffer.from("Review closely").toString("base64") }],
  });
  assert.notEqual(updated.files[0]?.digest, persona.files[0]?.digest);
  const renamed = await toolJson(PersonaSchema, "tumpel_persona_patch", {
    personaId: persona.personaId,
    name: "Close reviewer",
    boxMemoryMib: 4096,
  });
  assert.deepEqual(renamed, { ...updated, name: "Close reviewer", boxMemoryMib: 4096, updatedAt: renamed.updatedAt });
  const keylessPatch = await send(
    "PATCH",
    `/v1/personas/${persona.personaId}`,
    { secretSetId: defaultSet.secretSetId },
    bearer,
  );
  assert.equal(keylessPatch.status, 422);
  assert.equal(ProblemSchema.parse(await keylessPatch.json()).code, "NoCredential");
  const keyless = await send(
    "PUT",
    `/v1/personas/${persona.personaId}`,
    { name: "Reviewer", secretSetId: defaultSet.secretSetId, connectorIds: [], files: [] },
    bearer,
  );
  assert.equal(keyless.status, 422);
  assert.equal(ProblemSchema.parse(await keyless.json()).code, "NoCredential");
  const unlisted = await send(
    "PUT",
    `/v1/personas/${persona.personaId}`,
    { name: "Reviewer", secretSetId: secretSet.secretSetId, files: [] },
    bearer,
  );
  assert.equal(unlisted.status, 400);
  assert.equal(ProblemSchema.parse(await unlisted.json()).title, "Connectors missing");
  const recall = await toolJson(ConnectorSchema, "tumpel_connector_create_static", {
    name: "Recall",
    url: "https://recall.example.com/mcp",
  });
  assert.equal(recall.status.state, "NotConnected");
  assert.match(
    (await tool("tumpel_connector_set_token", { connectorId: recall.connectorId })).content[0]?.text ?? "",
    /tumpel connector set-token .* --stdin/,
  );
  const unconditional = await send(
    "PUT",
    `/v1/static-connectors/${recall.connectorId}/token`,
    { value: SECRET },
    bearer,
  );
  assert.equal(unconditional.status, 400);
  assert.equal(ProblemSchema.parse(await unconditional.json()).code, "InvalidRequest");
  const connected = await rest(
    ConnectorSchema,
    "PUT",
    `/v1/static-connectors/${recall.connectorId}/token?updatedAt=${recall.updatedAt}`,
    { value: SECRET },
  );
  assert.equal(connected.status.state, "Connected");
  assert.ok(connected.updatedAt > recall.updatedAt);
  const stale = await send(
    "PUT",
    `/v1/connectors/${recall.connectorId}?updatedAt=${recall.updatedAt}`,
    { name: "Stale" },
    bearer,
  );
  assert.equal(stale.status, 409);
  assert.equal(ProblemSchema.parse(await stale.json()).code, "ConnectorChanged");
  assert.deepEqual(await rest(ConnectorSchema, "GET", `/v1/connectors/${recall.connectorId}`), connected);
  const repeated = await send(
    "PUT",
    `/v1/personas/${persona.personaId}`,
    {
      name: "Reviewer",
      secretSetId: secretSet.secretSetId,
      connectorIds: [recall.connectorId, recall.connectorId],
      files: [],
    },
    bearer,
  );
  assert.equal(repeated.status, 422);
  const listing = await toolJson(PersonaSchema, "tumpel_persona_update", {
    personaId: persona.personaId,
    name: "Reviewer",
    secretSetId: secretSet.secretSetId,
    connectorIds: [recall.connectorId],
    files: [],
  });
  assert.deepEqual(listing.connectorIds, [recall.connectorId]);
  const malformed = await send("DELETE", `/v1/connectors/${recall.connectorId}?updatedAt=soon`, undefined, bearer);
  assert.equal(malformed.status, 400);
  assert.equal(ProblemSchema.parse(await malformed.json()).code, "InvalidRequest");
  const inUse = await send(
    "DELETE",
    `/v1/connectors/${recall.connectorId}?updatedAt=${connected.updatedAt}`,
    undefined,
    bearer,
  );
  assert.equal(inUse.status, 409);
  assert.equal(ProblemSchema.parse(await inUse.json()).code, "ConnectorInUse");
  const disconnected = await toolJson(ConnectorSchema, "tumpel_connector_clear_credential", {
    connectorId: recall.connectorId,
    updatedAt: connected.updatedAt,
  });
  assert.equal(disconnected.status.state, "Disconnected");
  assert.deepEqual(
    await toolJson(ConnectorSchema.array(), "tumpel_connector_list"),
    await rest(ConnectorSchema.array(), "GET", "/v1/connectors"),
  );
  assert.equal(JSON.stringify(await rest(ConnectorSchema.array(), "GET", "/v1/connectors")).includes(SECRET), false);
  await toolJson(PersonaSchema, "tumpel_persona_update", {
    personaId: persona.personaId,
    name: "Reviewer",
    secretSetId: secretSet.secretSetId,
    connectorIds: [],
    files: [],
  });
  assert.match(
    (await tool("tumpel_connector_delete", { connectorId: recall.connectorId, updatedAt: connected.updatedAt }))
      .content[0]?.text ?? "",
    /Connector changed/,
  );
  await toolDone("tumpel_connector_delete", { connectorId: recall.connectorId, updatedAt: disconnected.updatedAt });
  assert.deepEqual(
    await toolJson(StoredPersonaSchema.array(), "tumpel_persona_list"),
    await rest(StoredPersonaSchema.array(), "GET", "/v1/personas"),
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
  const drafted = await tool("tumpel_secret_set_set_member", {
    secretSetId: secretSet.secretSetId,
    member: { kind: "Variable", name: "GITHUB_TOKEN" },
  });
  assert.equal(
    drafted.content[0]?.text.split(": ")[1],
    `tumpel secret-set set-member variable ${secretSet.secretSetId} --name GITHUB_TOKEN --stdin`,
  );
  await rest(SecretSetSchema, "PUT", `/v1/secret-sets/${secretSet.secretSetId}/members`, {
    kind: "Variable",
    name: "REVIEW_MODE",
    value: "strict",
  });
  const patchedSet = await toolJson(SecretSetSchema, "tumpel_secret_set_patch", {
    secretSetId: secretSet.secretSetId,
    name: "prod-patched",
    secrets: [{ kind: "Variable", name: "REVIEW_LEVEL", previousName: "REVIEW_MODE" }],
  });
  assert.equal(patchedSet.name, "prod-patched");
  assert.deepEqual(patchedSet.keys.map((key) => key.name).sort(), ["ANTHROPIC_API_KEY", "REVIEW_LEVEL"]);
  assert.deepEqual(
    patchedSet.keys.find((key) => key.name === "ANTHROPIC_API_KEY"),
    secretSet.keys[0],
  );
  const patchedValue = await tool("tumpel_secret_set_patch", {
    secretSetId: secretSet.secretSetId,
    secrets: [{ kind: "Variable", name: "REVIEW_LEVEL", value: SECRET }],
  });
  assert.ok(patchedValue.isError);
  assert.ok(!JSON.stringify(patchedValue).includes(SECRET));
  const renamedOnto = await send(
    "PATCH",
    `/v1/secret-sets/${secretSet.secretSetId}`,
    { secrets: [{ kind: "Variable", name: "ANTHROPIC_API_KEY", previousName: "REVIEW_LEVEL" }] },
    bearer,
  );
  assert.equal(renamedOnto.status, 409);
  assert.deepEqual(await rest(SecretSetSchema, "GET", `/v1/secret-sets/${secretSet.secretSetId}`), patchedSet);
  await toolJson(SecretSetSchema, "tumpel_secret_set_remove_member", {
    secretSetId: secretSet.secretSetId,
    name: "REVIEW_LEVEL",
  });
  const removed = await toolJson(SecretSetSchema, "tumpel_secret_set_remove_member", {
    secretSetId: secretSet.secretSetId,
    name: "ANTHROPIC_API_KEY",
  });
  assert.deepEqual(removed.keys, []);
  await toolDone("tumpel_secret_set_delete", { secretSetId: secretSet.secretSetId });
  assert.deepEqual(await rest(SecretSetSchema.array(), "GET", "/v1/secret-sets"), [defaultSet]);

  const devices = await toolJson(DeviceSchema.array(), "tumpel_devices_list");
  assert.deepEqual(devices, await rest(DeviceSchema.array(), "GET", "/v1/devices"));
  const [device] = devices;
  assert.ok(device);
  await toolDone("tumpel_devices_revoke", { deviceId: device.deviceId });
  assert.equal((await call("/v1/whoami", { headers: bearer })).status, 401);
});
