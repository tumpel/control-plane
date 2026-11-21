import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ConnectionSummarySchema,
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  NamespaceConnectionLinkSchema,
  OpenRouterAuthorizationSchema,
  PersonaSchema,
  PrebuildSchema,
  ProblemSchema,
  SecretSetSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import type { z } from "zod";
import { CLAUDE_CODE_AMD64_RELEASE } from "./release-fixture.ts";
import { pollInterval, TEST_SETTINGS } from "./timing.ts";

type Bucket = { put(key: string, value: string): Promise<unknown> };

const AUDIENCE = "tumpel-prebuilds-e2e";
const KID = "prebuilds-e2e-key";
const EMAIL = "prebuilds@example.test";
const REPOSITORY = "https://github.com/acme/app.git";
const OPENROUTER_CODE = "openrouter-approved-code";
const OPENROUTER_KEY = "openrouter-minted-key";
const keyExchanges: { code: string; code_verifier: string }[] = [];

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;
let bearer: Record<string, string>;

const assertion = (): string => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], email: EMAIL, iat: now, nbf: now, exp: now + 600 });
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`;
};

const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  server.fetch(`${origin}${path}`, {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const rest = async <T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown): Promise<T> => {
  const response = await send(method, path, body, bearer);
  assert.equal(response.status, 200, `${method} ${path}: ${await response.clone().text()}`);
  return schema.parse(await response.json());
};

const refused = async (method: string, path: string, body: unknown, status: number) => {
  const response = await send(method, path, body, bearer);
  assert.equal(response.status, status, `${method} ${path}`);
  return ProblemSchema.parse(await response.json());
};

const deviceToken = async (tenantId: string): Promise<string> => {
  const started = DeviceAuthorizationSchema.parse(
    await (await send("POST", "/v1/device/code", { device_name: "prebuilds e2e" })).json(),
  );
  const browser = { "cf-access-jwt-assertion": assertion(), origin };
  assert.equal(
    (await send("POST", "/v1/device/approve", { userCode: started.user_code, tenantId }, browser)).status,
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

before(async () => {
  certs = createServer((request, response) => {
    const path = request.url ?? "";
    if (request.method === "POST" && path === "/openrouter/api/v1/auth/keys") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const grant = JSON.parse(body);
        keyExchanges.push(grant);
        const approved = grant.code === OPENROUTER_CODE;
        response.writeHead(approved ? 200 : 403, { "content-type": "application/json" });
        response.end(JSON.stringify(approved ? { key: OPENROUTER_KEY } : { error: { message: "Invalid code" } }));
      });
      return;
    }
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
          API_ORIGIN: "https://api.tumpel.test",
          OPENROUTER_ORIGIN: `${issuer}/openrouter`,
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  await (await server.getWorker<{ RELEASES: Bucket }>().getEnv()).RELEASES.put(
    "current.json",
    JSON.stringify(CLAUDE_CODE_AMD64_RELEASE),
  );
  const browser = { "cf-access-jwt-assertion": assertion(), origin };
  const signedUp = await send("POST", "/v1/tenants", { name: "Prebuilds" }, browser);
  assert.equal(signedUp.status, 200);
  const { tenantId } = WhoamiSchema.parse(await signedUp.json()).tenant;
  bearer = { authorization: `Bearer ${await deviceToken(tenantId)}` };
});

after(async () => {
  await server?.close();
  certs?.close();
});

test("a prebuild start refuses before it stores anything: an unreadable repository, a foreign repository, an unknown persona", async () => {
  const [persona] = await rest(PersonaSchema.array(), "GET", "/v1/personas");
  assert.ok(persona);
  const unnamed = { repository: REPOSITORY, personaId: persona.personaId, rebuild: false };
  const start = { ...unnamed, provider: "Namespace" };
  const unreadable = await refused("POST", "/v1/prebuilds", start, 409);
  assert.equal(unreadable.code, "RepositoryUnreadable");
  assert.match(unreadable.detail, /acme\/app/);
  assert.equal((await refused("POST", "/v1/prebuilds", unnamed, 400)).code, "InvalidRequest");
  assert.equal(
    (await refused("POST", "/v1/prebuilds", { ...start, repository: "https://example.test/app.git" }, 422)).code,
    "InvalidRequest",
  );
  assert.equal((await refused("POST", "/v1/prebuilds", { ...start, personaId: "missing" }, 404)).code, "NotFound");

  for (const repository of [REPOSITORY, "https://github.com/Acme/App"]) {
    const query = new URLSearchParams({ repository });
    assert.deepEqual(await rest(PrebuildSchema.array(), "GET", `/v1/prebuilds?${query}`), []);
  }
  assert.equal((await refused("GET", "/v1/prebuilds/missing", undefined, 404)).code, "NotFound");
  assert.equal((await refused("GET", "/v1/prebuilds/missing/failure", undefined, 404)).code, "NotFound");
});

const ConnectionRows = ConnectionSummarySchema.array();

test("the connection list holds one row per provider, and a connected build provider shows its billing account", async () => {
  assert.deepEqual(await rest(ConnectionRows, "GET", "/v1/connections"), [
    { kind: "GitHub", state: "NotConfigured" },
    { kind: "Namespace", state: "NotConfigured" },
    { kind: "OpenRouter", state: "NotConnected" },
  ]);

  const namespace = await rest(NamespaceConnectionLinkSchema, "GET", "/v1/namespace-connection");
  assert.equal(namespace.link.state, "NotConfigured");
  const start = {
    accountLabel: "acme workspace",
    workspaceId: "tenant_123456789ab",
  };
  assert.equal((await refused("POST", "/v1/namespace-connection/start", start, 409)).code, "IssuerMissing");

  assert.deepEqual(await rest(ConnectionRows, "GET", "/v1/connections"), [
    { kind: "GitHub", state: "NotConfigured" },
    { kind: "Namespace", state: "NotConfigured" },
    { kind: "OpenRouter", state: "NotConnected" },
  ]);
});

test("Connect OpenRouter spends one code into the secret set, fails on its deadline, and refuses a forged state and a second OpenRouter credential", async () => {
  const authorize = "/v1/openrouter-connection/authorize";
  const read = (openRouterAuthorizationId: string) =>
    rest(OpenRouterAuthorizationSchema, "GET", `/v1/openrouter-connection/authorizations/${openRouterAuthorizationId}`);
  const callbackOf = (authorizeUrl: string): string =>
    new URL(new URL(authorizeUrl).searchParams.get("callback_url") ?? "").pathname;
  const set = await rest(SecretSetSchema, "POST", "/v1/secret-sets", { name: "openrouter", secrets: [] });

  const started = await rest(OpenRouterAuthorizationSchema, "POST", authorize, { secretSetId: set.secretSetId });
  assert.ok(started.status.state === "AwaitingCallback");
  assert.equal(new URL(started.status.authorizeUrl).searchParams.get("code_challenge_method"), "S256");
  const callback = callbackOf(started.status.authorizeUrl);
  const landed = await send("GET", `${callback}?code=${OPENROUTER_CODE}`, undefined);
  assert.equal(landed.status, 303);
  const back = new URL(landed.headers.get("location") ?? "");
  assert.equal(back.pathname, `/t/${set.tenantId}/secrets/${set.secretSetId}`);
  assert.equal(back.searchParams.get("openRouterAuthorizationId"), started.openRouterAuthorizationId);
  assert.equal(keyExchanges.length, 1);
  assert.equal(keyExchanges[0]?.code, OPENROUTER_CODE);

  const stored = await rest(SecretSetSchema, "GET", `/v1/secret-sets/${set.secretSetId}`);
  assert.deepEqual(
    stored.keys.map((key) => (key.kind === "ApiKey" ? [key.name, key.provider] : [key.name])),
    [["OPENROUTER_API_KEY", "OpenRouter"]],
  );
  const completed = await read(started.openRouterAuthorizationId);
  assert.equal(completed.status.state, "Completed");
  assert.doesNotMatch(JSON.stringify([stored, completed]), new RegExp(OPENROUTER_KEY));
  assert.deepEqual(
    (await rest(ConnectionRows, "GET", "/v1/connections")).find((row) => row.kind === "OpenRouter"),
    { kind: "OpenRouter", state: "Connected", account: "openrouter" },
  );

  assert.equal((await send("GET", `${callback}?code=${OPENROUTER_CODE}`, undefined)).status, 303);
  assert.equal(keyExchanges.length, 1);

  const [body, signature] = callback.slice("/openrouter/callback/".length).split(".");
  const claims = JSON.parse(Buffer.from(body ?? "", "base64url").toString());
  const forged = Buffer.from(JSON.stringify({ ...claims, tenantId: "tnt_other" })).toString("base64url");
  const refusedState = await send(
    "GET",
    `/openrouter/callback/${forged}.${signature}?code=${OPENROUTER_CODE}`,
    undefined,
  );
  assert.equal(refusedState.status, 400);
  assert.equal(keyExchanges.length, 1);

  const other = await rest(SecretSetSchema, "POST", "/v1/secret-sets", {
    name: "pasted openrouter",
    secrets: [
      { kind: "ApiKey", name: "OTHER_OPENROUTER_KEY", provider: "OpenRouter", value: "sk-or-pasted-openrouter-key" },
    ],
  });
  assert.equal((await refused("POST", authorize, { secretSetId: other.secretSetId }, 409)).code, "Conflict");
});
