import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CircleCIAuthorizationSchema,
  CircleCIConnectionLinkSchema,
  CircleCIProjectSchema,
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  ProblemSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { generateDataKey, seal } from "../src/envelope.ts";
import { workersSecretKeyStore } from "../src/key-store.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "./release-fixture.ts";
import { pollInterval, TEST_SETTINGS } from "./timing.ts";

const ACCESS_AUD = "tumpel-circleci-e2e";
const ACCESS_KID = "access-key";
const EMAIL = "circleci@example.test";
const SECRETS_KEK = Buffer.alloc(32, 9).toString("base64");
const INSTALLATION_ID = 88;
const HEAD_SHA = "c".repeat(40);
const TREE_SHA = "1".repeat(40);
const DEVCONTAINER_TREE_SHA = "5".repeat(40);
const REPOSITORY = "https://github.com/acme/app";
const TOKEN = "circleci-personal-token";
const ORGANIZATION = "6f1c2b3a-0d4e-4f5a-9b8c-7d6e5f4a3b2c";
const PROJECT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DEFINITION = "11111111-2222-4333-8444-555555555555";
const SLUG = `circleci/${ORGANIZATION}/${PROJECT}`;

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = rsa();
const circle = rsa();
const CIRCLE_KID = "circleci-job-key";
const app = rsa();

const publicJwk = (key: KeyObject, kid: string) => ({
  ...key.export({ format: "jwk" }),
  kid,
  alg: "RS256",
  use: "sig",
});
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const signed = (header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject): string => {
  const body = `${encode(header)}.${encode(claims)}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
};
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

type Bucket = { put(key: string, value: string): Promise<unknown> };
type Database = { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };
type Bindings = { DB: Database; RELEASES: Bucket; STORE: { put(key: string, value: Uint8Array): Promise<unknown> } };

let fake: Server;
let fakeOrigin: string;
let server: TestHarness;
let origin: string;
let bearer: Record<string, string>;
let tenantId: string;
const webhooks: Record<string, unknown>[] = [];
const deletedWebhooks: string[] = [];
let tokenCalls = 0;

const reply = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const bodyOf = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
};

const fakeGitHub = (request: IncomingMessage, response: ServerResponse, path: string) => {
  if (request.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
    return reply(response, 201, {
      token: "installation-token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { actions: "write", contents: "write", workflows: "write" },
    });
  }
  if (path === "/repos/acme/app") return reply(response, 200, { default_branch: "main" });
  if (path === "/repos/acme/app/commits/main") {
    return reply(response, 200, { sha: HEAD_SHA, commit: { tree: { sha: TREE_SHA } } });
  }
  if (path === `/repos/acme/app/git/trees/${TREE_SHA}`) {
    return reply(response, 200, {
      tree: [
        { path: ".devcontainer", type: "tree", sha: DEVCONTAINER_TREE_SHA },
        { path: "package-lock.json", type: "blob", sha: "2".repeat(40) },
      ],
    });
  }
  if (path === `/repos/acme/app/git/trees/${DEVCONTAINER_TREE_SHA}?recursive=1`) {
    return reply(response, 200, { tree: [{ path: "devcontainer.json", type: "blob", sha: "4".repeat(40) }] });
  }
  return reply(response, 404, { message: "Not Found" });
};

const fakeCircleCI = async (request: IncomingMessage, response: ServerResponse, path: string) => {
  const body = await bodyOf(request);
  if (request.headers["circle-token"] !== TOKEN) return reply(response, 401, { message: "Invalid token provided." });
  if (path === "/me") return reply(response, 200, { id: "u1", login: "acme-bot" });
  if (path === "/me/collaborations") {
    return reply(response, 200, [
      { id: ORGANIZATION, name: "acme", slug: "gh/acme", "vcs-type": "github", avatar_url: "" },
    ]);
  }
  if (path === `/project/${SLUG}`)
    return reply(response, 200, { id: PROJECT, slug: SLUG, organization_id: ORGANIZATION });
  if (path === `/projects/${PROJECT}/pipeline-definitions/${DEFINITION}`) {
    const repo = { full_name: "acme/app", external_id: "7" };
    return reply(response, 200, {
      id: DEFINITION,
      config_source: { provider: "github_app", repo, file_path: ".circleci/tumpel-prebuild.yml" },
      checkout_source: { provider: "github_app", repo },
    });
  }
  if (request.method === "POST" && path === "/webhook") {
    webhooks.push(body);
    return reply(response, 201, { id: `webhook-${webhooks.length}` });
  }
  if (request.method === "DELETE" && path.startsWith("/webhook/")) {
    deletedWebhooks.push(path.slice("/webhook/".length));
    return reply(response, 200, { message: "ok" });
  }
  return reply(response, 404, { message: "Not found." });
};

const assertion = (): string => {
  const now = nowSeconds();
  return signed(
    { alg: "RS256", kid: ACCESS_KID, typ: "JWT" },
    { iss: fakeOrigin, aud: [ACCESS_AUD], email: EMAIL, iat: now, nbf: now, exp: now + 600 },
    access.privateKey,
  );
};

const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  server.fetch(`${origin}${path}`, {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

before(async () => {
  fake = createServer((request, response) => {
    const path = request.url ?? "";
    if (path.startsWith("/api/")) return fakeGitHub(request, response, path.slice("/api".length));
    if (path.startsWith("/circleci/api/v2/")) {
      return void fakeCircleCI(request, response, path.slice("/circleci/api/v2".length));
    }
    if (path === "/app/oauth/register") return reply(response, 201, { client_id: "tumpel-client" });
    if (path === "/app/oauth/token") {
      tokenCalls += 1;
      return reply(response, 200, { access_token: TOKEN, token_type: "Bearer", expires_in: 7776000 });
    }
    if (/^\/oidc\/org\/[0-9a-f-]+\/\.well-known\/jwks-pub\.json$/.test(path)) {
      return reply(response, 200, { keys: [publicJwk(circle.publicKey, CIRCLE_KID)] });
    }
    if (path === "/cdn-cgi/access/certs")
      return reply(response, 200, { keys: [publicJwk(access.publicKey, ACCESS_KID)] });
    return reply(response, 404, {});
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  fakeOrigin = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  server = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          TUMPEL_SETTINGS: TEST_SETTINGS,
          ACCESS_ISSUER: fakeOrigin,
          ACCESS_AUD,
          R2_STUB_ORIGIN: "https://r2.example.test",
          DASHBOARD_ORIGIN: "https://app.tumpel.test",
          GITHUB_API_ORIGIN: `${fakeOrigin}/api`,
          CIRCLECI_API_ORIGIN: `${fakeOrigin}/circleci`,
          CIRCLECI_OIDC_ORIGIN: `${fakeOrigin}/oidc`,
          CIRCLECI_APP_ORIGIN: `${fakeOrigin}/app`,
          SECRETS_KEK,
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  const browser = { "cf-access-jwt-assertion": assertion(), origin };
  const created = await send("POST", "/v1/tenants", { name: "CircleCI" }, browser);
  assert.equal(created.status, 200);
  tenantId = WhoamiSchema.parse(await created.json()).tenant.tenantId;
  const started = DeviceAuthorizationSchema.parse(
    await (await send("POST", "/v1/device/code", { device_name: "circleci e2e" })).json(),
  );
  assert.equal(
    (await send("POST", "/v1/device/approve", { userCode: started.user_code, tenantId }, browser)).status,
    200,
  );
  await pollInterval(started.interval);
  const granted = await send("POST", "/v1/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: started.device_code,
  });
  bearer = { authorization: `Bearer ${DeviceTokenSchema.parse(await granted.json()).access_token}` };
  const env = await server.getWorker<Bindings>().getEnv();
  await env.RELEASES.put("current.json", JSON.stringify(CLAUDE_CODE_AMD64_RELEASE));
  const keyStore = workersSecretKeyStore(SECRETS_KEK);
  const dataKey = await generateDataKey();
  const privateKey = app.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  await env.DB.prepare(
    `INSERT INTO github_apps (github_app_slot, app_id, slug, client_id, owner_login, html_url, wrapped_data_key,
    client_secret_sealed, webhook_secret_sealed, private_key_sealed, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      1,
      "tumpel-circleci",
      "Iv1.circleci",
      "acme",
      "https://github.com/apps/tumpel-circleci",
      await keyStore.wrap(dataKey),
      await seal(dataKey, "client-secret", "github-app/client_secret"),
      await seal(dataKey, "webhook-secret", "github-app/webhook_secret"),
      await seal(dataKey, privateKey, "github-app/private_key"),
      Date.now(),
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO github_installations (installation_id, tenant_id, account_login, account_type, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Organization', 'Active', ?, ?)`,
  )
    .bind(INSTALLATION_ID, tenantId, "acme", Date.now(), Date.now())
    .run();
  const connected = await send(
    "POST",
    "/v1/circleci-connection/start",
    { accountLabel: "acme on CircleCI", organizationId: ORGANIZATION, apiToken: TOKEN },
    bearer,
  );
  assert.equal(connected.status, 200, await connected.clone().text());
  CircleCIConnectionLinkSchema.parse(await connected.json());
});

after(async () => {
  await server?.close();
  fake?.close();
});

const addBinding = async () => {
  const response = await send(
    "POST",
    "/v1/circleci-projects",
    { repository: `${REPOSITORY}.git`, projectSlug: SLUG, pipelineDefinitionId: DEFINITION },
    bearer,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return CircleCIProjectSchema.parse(await response.json());
};

const signingSecret = (): string => String(webhooks.at(-1)?.["signing-secret"]);

test("a binding registers a signed workflow-completed webhook on its project", async () => {
  await addBinding();
  const hook = webhooks.at(-1);
  assert.deepEqual(hook?.events, ["workflow-completed"]);
  assert.deepEqual(hook?.scope, { id: PROJECT, type: "project" });
  assert.equal(hook?.url, `${origin}/v1/circleci-events/${tenantId}`);
  assert.match(signingSecret(), /^[0-9a-f]{64}$/);
});

test("a second repository is refused on a project another binding holds, before any webhook", async () => {
  const hooks = webhooks.length;
  const response = await send(
    "POST",
    "/v1/circleci-projects",
    { repository: "https://github.com/acme/other.git", projectSlug: SLUG, pipelineDefinitionId: DEFINITION },
    bearer,
  );
  assert.equal(response.status, 409);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "Conflict");
  assert.equal(problem.title, "Project already bound");
  assert.equal(webhooks.length, hooks);
});

test("deleting a binding deletes its webhook at CircleCI", async () => {
  const [binding] = CircleCIProjectSchema.array().parse(
    await (await send("GET", "/v1/circleci-projects", undefined, bearer)).json(),
  );
  assert.ok(binding);
  assert.equal(
    (await send("DELETE", `/v1/circleci-projects/${binding.circleCIProjectId}`, undefined, bearer)).status,
    204,
  );
  assert.deepEqual(deletedWebhooks, [`webhook-${webhooks.length}`]);
  await addBinding();
});

test("a redirect with another state, or replayed after Completed, never reaches the token endpoint", async () => {
  const started = CircleCIAuthorizationSchema.parse(
    await (await send("POST", "/v1/circleci-connection/authorize", undefined, bearer)).json(),
  );
  assert.equal(started.status.state, "AwaitingRedirect");
  const state =
    started.status.state === "AwaitingRedirect" ? new URL(started.status.authorizeUrl).searchParams.get("state") : null;
  assert.ok(state);
  const complete = (sent: string) =>
    send(
      "POST",
      "/v1/circleci-connection/complete",
      {
        circleCIAuthorizationId: started.circleCIAuthorizationId,
        redirectedUrl: `http://127.0.0.1:47151/circleci/callback?code=one-time&state=${encodeURIComponent(sent)}`,
      },
      bearer,
    );
  const before = tokenCalls;
  assert.equal((await complete("another-state")).status, 422);
  assert.equal(tokenCalls, before);
  const completed = CircleCIAuthorizationSchema.parse(await (await complete(state)).json());
  assert.equal(completed.status.state, "Completed");
  assert.equal(tokenCalls, before + 1);
  assert.equal((await complete(state)).status, 409);
  assert.equal(tokenCalls, before + 1);
});

test("deleting the connection deletes the webhooks of its bindings at CircleCI", async () => {
  const bindings = CircleCIProjectSchema.array().parse(
    await (await send("GET", "/v1/circleci-projects", undefined, bearer)).json(),
  );
  assert.ok(bindings.length > 0);
  const deletedBefore = deletedWebhooks.length;
  assert.equal((await send("DELETE", "/v1/circleci-connection", undefined, bearer)).status, 204);
  assert.deepEqual(deletedWebhooks.slice(deletedBefore), [`webhook-${webhooks.length}`]);
  assert.deepEqual(
    CircleCIProjectSchema.array().parse(await (await send("GET", "/v1/circleci-projects", undefined, bearer)).json()),
    [],
  );
});
