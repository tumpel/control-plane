import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CircleCIConnectionLinkSchema,
  CircleCIProjectSchema,
  ConnectionSummarySchema,
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  GitHubActionsConnectionLinkSchema,
  NamespaceConnectionLinkSchema,
  OpenRouterAuthorizationSchema,
  PersonaSchema,
  PrebuildSchema,
  ProblemSchema,
  SecretSetSchema,
  WhoamiSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import type { z } from "zod";
import { CLAUDE_CODE_AMD64_RELEASE } from "./release-fixture.ts";

type Bucket = { put(key: string, value: string): Promise<unknown> };
type TenantStub = { recordDispatchedPrebuild(tenantId: string, dispatch: unknown, now: number): Promise<unknown> };
type OpenRouterTenant = {
  openRouterAuthorizationDeadlineReached(deadline: { openRouterAuthorizationId: string; at: number }): Promise<void>;
};

const AUDIENCE = "tumpel-prebuilds-e2e";
const KID = "prebuilds-e2e-key";
const EMAIL = "prebuilds@example.test";
const REPOSITORY = "https://github.com/acme/app.git";
const CIRCLECI_TOKEN = "circleci-personal-token";
const CIRCLECI_ORGANIZATION = "6f1c2b3a-0d4e-4f5a-9b8c-7d6e5f4a3b2c";
const CIRCLECI_PROJECT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CIRCLECI_DEFINITION = "11111111-2222-4333-8444-555555555555";
const FOREIGN_DEFINITION = "99999999-2222-4333-8444-555555555555";
const PROJECT_SLUG = `circleci/${CIRCLECI_ORGANIZATION}/${CIRCLECI_PROJECT}`;
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
  await new Promise((resolve) => setTimeout(resolve, started.interval * 1000 + 100));
  const granted = await send("POST", "/v1/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: started.device_code,
  });
  assert.equal(granted.status, 200);
  return DeviceTokenSchema.parse(await granted.json()).access_token;
};

const fakeCircleCI = (path: string, token: unknown): { status: number; body: unknown } => {
  if (token !== CIRCLECI_TOKEN) return { status: 401, body: { message: "Invalid token provided." } };
  if (path === "/me") return { status: 200, body: { id: "u1", login: "acme-bot", name: "Acme Bot" } };
  if (path === "/webhook") return { status: 201, body: { id: "webhook-1" } };
  if (path === "/webhook/webhook-1") return { status: 200, body: { message: "ok" } };
  if (path === `/project/${PROJECT_SLUG}`) {
    return { status: 200, body: { id: CIRCLECI_PROJECT, slug: PROJECT_SLUG, organization_id: CIRCLECI_ORGANIZATION } };
  }
  const definition = /^\/projects\/([^/]+)\/pipeline-definitions\/([^/]+)$/.exec(path);
  if (
    definition?.[1] === CIRCLECI_PROJECT &&
    (definition[2] === CIRCLECI_DEFINITION || definition[2] === FOREIGN_DEFINITION)
  ) {
    const repo = { full_name: definition[2] === CIRCLECI_DEFINITION ? "Acme/App" : "acme/other", external_id: "7" };
    return {
      status: 200,
      body: {
        id: definition[2],
        config_source: { provider: "github_app", repo, file_path: ".circleci/tumpel-prebuild.yml" },
        checkout_source: { provider: "github_app", repo },
      },
    };
  }
  return { status: 404, body: { message: "Not found." } };
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
    if (!path.startsWith("/circleci/api/v2/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    const answer = fakeCircleCI(path.slice("/circleci/api/v2".length), request.headers["circle-token"]);
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
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
          CIRCLECI_API_ORIGIN: `${issuer}/circleci`,
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

test("a prebuild start refuses before it stores anything: an unconnected provider, a foreign repository, an unknown persona", async () => {
  const [persona] = await rest(PersonaSchema.array(), "GET", "/v1/personas");
  assert.ok(persona);
  const unnamed = { repository: REPOSITORY, personaId: persona.personaId, rebuild: false };
  const start = { ...unnamed, provider: "GitHubActions" };
  const problem = await refused("POST", "/v1/prebuilds", start, 409);
  assert.equal(problem.code, "NoBuildProvider");
  assert.match(problem.detail, /GitHubActions/);
  assert.match(problem.fix, /tumpel github-actions start/);
  const circleCI = await refused("POST", "/v1/prebuilds", { ...start, provider: "CircleCI" }, 409);
  assert.equal(circleCI.code, "NoBuildProvider");
  assert.match(circleCI.fix, /tumpel circleci authorize/);
  const namespace = await refused("POST", "/v1/prebuilds", { ...start, provider: "Namespace", rebuild: true }, 409);
  assert.equal(namespace.code, "NoBuildProvider");
  assert.match(namespace.fix, /tumpel namespace start/);
  assert.equal((await refused("POST", "/v1/prebuilds", unnamed, 400)).code, "InvalidRequest");
  assert.equal(
    (await refused("POST", "/v1/prebuilds", { ...start, repository: "https://example.test/app.git" }, 422)).code,
    "InvalidRequest",
  );
  assert.equal((await refused("POST", "/v1/prebuilds", { ...start, personaId: "missing" }, 404)).code, "NotFound");

  await rest(GitHubActionsConnectionLinkSchema, "POST", "/v1/github-actions-connection/start", {
    accountLabel: "acme on GitHub Actions",
    callerWorkflow: ".github/workflows/tumpel-prebuild.yml",
  });
  const anonymous = await refused("POST", "/v1/prebuilds", start, 409);
  assert.equal(anonymous.code, "RepositoryUnreadable");
  assert.match(anonymous.detail, /no token reads acme\/app/);
  assert.equal((await send("DELETE", "/v1/github-actions-connection", undefined, bearer)).status, 204);

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
    { kind: "GitHubActions", state: "NotConnected" },
    { kind: "CircleCI", state: "NotConnected" },
    { kind: "Namespace", state: "NotConfigured" },
    { kind: "OpenRouter", state: "NotConnected" },
  ]);

  const actions = await rest(GitHubActionsConnectionLinkSchema, "POST", "/v1/github-actions-connection/start", {
    accountLabel: "acme on GitHub Actions",
    callerWorkflow: ".github/workflows/tumpel-prebuild.yml",
  });
  assert.equal(actions.link.state, "Connected");
  assert.deepEqual(await rest(GitHubActionsConnectionLinkSchema, "GET", "/v1/github-actions-connection"), actions);
  assert.equal(
    (
      await refused(
        "POST",
        "/v1/github-actions-connection/start",
        { accountLabel: "acme", callerWorkflow: "ci.yml" },
        400,
      )
    ).code,
    "InvalidRequest",
  );

  const namespace = await rest(NamespaceConnectionLinkSchema, "GET", "/v1/namespace-connection");
  assert.equal(namespace.link.state, "NotConfigured");
  const start = {
    accountLabel: "acme workspace",
    workspaceId: "tenant_123456789ab",
  };
  assert.equal((await refused("POST", "/v1/namespace-connection/start", start, 409)).code, "IssuerMissing");

  assert.deepEqual(await rest(ConnectionRows, "GET", "/v1/connections"), [
    { kind: "GitHub", state: "NotConfigured" },
    { kind: "GitHubActions", state: "Connected", account: "acme on GitHub Actions" },
    { kind: "CircleCI", state: "NotConnected" },
    { kind: "Namespace", state: "NotConfigured" },
    { kind: "OpenRouter", state: "NotConnected" },
  ]);

  assert.equal((await send("DELETE", "/v1/github-actions-connection", undefined, bearer)).status, 204);
  assert.deepEqual(
    (await rest(ConnectionRows, "GET", "/v1/connections")).map((row) => row.state),
    ["NotConfigured", "NotConnected", "NotConnected", "NotConfigured", "NotConnected"],
  );
});

test("the latest listing answers the newest prebuild of each repository, by repository", async () => {
  const { tenant } = await rest(WhoamiSchema, "GET", "/v1/whoami");
  const [persona] = await rest(PersonaSchema.array(), "GET", "/v1/personas");
  assert.ok(persona);
  const stub = (
    await server.getWorker<{ TENANT: { getByName(name: string): TenantStub } }>().getEnv()
  ).TENANT.getByName(tenant.tenantId);
  const record = async (repository: string, seed: string, at: number) =>
    PrebuildSchema.parse(
      await stub.recordDispatchedPrebuild(
        tenant.tenantId,
        {
          prebuildId: crypto.randomUUID(),
          personaId: persona.personaId,
          run: { runId: at + seed.charCodeAt(0), headSha: "f".repeat(40) },
          key: { repository, inputDigest: seed.repeat(64), guestImageDigest: "c".repeat(64), configSource: "Default" },
          defaultBranch: "main",
          provider: "GitHubActions",
          logUrl: `${repository}/actions/runs/1`,
        },
        at,
      ),
    );
  const now = Date.now();
  await record("https://github.com/acme/web", "a", now - 3000);
  const web = await record("https://github.com/acme/web", "b", now - 1000);
  const app = await record("https://github.com/acme/app", "d", now - 2000);
  await record("https://github.com/acme/web", "e", now - 2000);

  const latest = await rest(PrebuildSchema.array(), "GET", "/v1/prebuilds/latest");
  assert.deepEqual(
    latest.map((prebuild) => prebuild.prebuildId),
    [app.prebuildId, web.prebuildId],
  );
});

test("CircleCI connects only with a token CircleCI accepts, binds a repository to a definition that checks it out, and a disconnect drops the bindings", async () => {
  const start = { accountLabel: "acme on CircleCI", organizationId: CIRCLECI_ORGANIZATION, apiToken: "mistyped" };
  const binding = { repository: REPOSITORY, projectSlug: PROJECT_SLUG, pipelineDefinitionId: CIRCLECI_DEFINITION };
  assert.equal((await refused("POST", "/v1/circleci-projects", binding, 409)).code, "NoBuildProvider");

  const mistyped = await refused("POST", "/v1/circleci-connection/start", start, 422);
  assert.equal(mistyped.code, "CircleCITokenRefused");
  assert.match(mistyped.detail, /\/api\/v2\/me with 401: Invalid token provided/);
  assert.equal((await rest(CircleCIConnectionLinkSchema, "GET", "/v1/circleci-connection")).link.state, "NotConnected");

  const connected = await rest(CircleCIConnectionLinkSchema, "POST", "/v1/circleci-connection/start", {
    ...start,
    apiToken: CIRCLECI_TOKEN,
  });
  assert.ok(connected.link.state === "Connected");
  assert.equal(connected.link.connection.issuer, `https://oidc.circleci.com/org/${CIRCLECI_ORGANIZATION}`);
  assert.equal(connected.orb, "tumpel/prebuild@1");
  assert.doesNotMatch(JSON.stringify(connected), new RegExp(CIRCLECI_TOKEN));

  const foreign = await refused(
    "POST",
    "/v1/circleci-projects",
    { ...binding, pipelineDefinitionId: FOREIGN_DEFINITION },
    422,
  );
  assert.equal(foreign.code, "CircleCIDefinitionMismatch");
  assert.match(foreign.detail, /checks out acme\/other/);
  const missing = await refused("POST", "/v1/circleci-projects", { ...binding, projectSlug: "gh/acme/missing" }, 404);
  assert.equal(missing.code, "CircleCIProjectMissing");

  const bound = await rest(CircleCIProjectSchema, "POST", "/v1/circleci-projects", binding);
  assert.equal(bound.repository, "https://github.com/acme/app");
  assert.equal(bound.projectId, CIRCLECI_PROJECT);
  assert.equal((await refused("POST", "/v1/circleci-projects", binding, 409)).code, "Conflict");
  assert.deepEqual(await rest(CircleCIProjectSchema.array(), "GET", "/v1/circleci-projects"), [bound]);

  assert.equal((await send("DELETE", "/v1/circleci-connection", undefined, bearer)).status, 204);
  assert.deepEqual(await rest(CircleCIProjectSchema.array(), "GET", "/v1/circleci-projects"), []);
  assert.equal(
    (await refused("DELETE", `/v1/circleci-projects/${bound.circleCIProjectId}`, undefined, 404)).code,
    "NotFound",
  );
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

  const late = await rest(OpenRouterAuthorizationSchema, "POST", authorize, { secretSetId: set.secretSetId });
  assert.ok(late.status.state === "AwaitingCallback");
  const tenant = (
    await server.getWorker<{ TENANT: { getByName(name: string): OpenRouterTenant } }>().getEnv()
  ).TENANT.getByName(set.tenantId);
  await tenant.openRouterAuthorizationDeadlineReached({
    openRouterAuthorizationId: late.openRouterAuthorizationId,
    at: Date.parse(late.status.callbackDueAt),
  });
  const timedOut = await read(late.openRouterAuthorizationId);
  assert.ok(timedOut.status.state === "Failed");
  assert.equal(timedOut.status.reason, "AuthorizationTimedOut");
  assert.equal(
    (await send("GET", `${callbackOf(late.status.authorizeUrl)}?code=${OPENROUTER_CODE}`, undefined)).status,
    303,
  );
  assert.equal(keyExchanges.length, 1);

  const other = await rest(SecretSetSchema, "POST", "/v1/secret-sets", {
    name: "pasted openrouter",
    secrets: [{ kind: "ApiKey", name: "OTHER_OPENROUTER_KEY", provider: "OpenRouter", value: "pasted-openrouter-key" }],
  });
  assert.equal((await refused("POST", authorize, { secretSetId: other.secretSetId }, 409)).code, "Conflict");
});
