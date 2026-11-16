import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
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
  PersonaSchema,
  PrebuildFailureSchema,
  PrebuildSchema,
  ProblemSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { z } from "zod";
import { generateDataKey, seal } from "../src/envelope.ts";
import { workersSecretKeyStore } from "../src/key-store.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "./release-fixture.ts";

const ACCESS_AUD = "tumpel-circleci-e2e";
const ACCESS_KID = "access-key";
const EMAIL = "circleci@example.test";
const SECRETS_KEK = Buffer.alloc(32, 9).toString("base64");
const INSTALLATION_ID = 88;
const HEAD_SHA = "c".repeat(40);
const TREE_SHA = "1".repeat(40);
const REPOSITORY = "https://github.com/acme/app";
const TOKEN = "circleci-personal-token";
const ORGANIZATION = "6f1c2b3a-0d4e-4f5a-9b8c-7d6e5f4a3b2c";
const PROJECT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const DEFINITION = "11111111-2222-4333-8444-555555555555";
const SLUG = `circleci/${ORGANIZATION}/${PROJECT}`;

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = rsa();
const circle = rsa();
const stranger = rsa();
const CIRCLE_KID = "circleci-job-key";
const revisions = new Map<string, string>();
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
let personaId: string;
let pipelines = 0;
let runAnswer: (() => { status: number; body: unknown }) | null = null;
const runs: unknown[] = [];
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
    return reply(response, 200, { tree: [{ path: "package-lock.json", type: "blob", sha: "2".repeat(40) }] });
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
  if (request.method === "GET" && path.startsWith("/pipeline/")) {
    const pipelineId = path.slice("/pipeline/".length);
    return reply(response, 200, { id: pipelineId, vcs: { revision: revisions.get(pipelineId) ?? HEAD_SHA } });
  }
  if (request.method === "POST" && path === "/webhook") {
    webhooks.push(body);
    return reply(response, 201, { id: `webhook-${webhooks.length}` });
  }
  if (request.method === "DELETE" && path.startsWith("/webhook/")) {
    deletedWebhooks.push(path.slice("/webhook/".length));
    return reply(response, 200, { message: "ok" });
  }
  if (request.method === "POST" && path === `/project/${SLUG}/pipeline/run`) {
    runs.push(body);
    if (runAnswer !== null) {
      const answer = runAnswer();
      return reply(response, answer.status, answer.body);
    }
    pipelines += 1;
    return reply(response, 201, { id: `pipeline-${pipelines}`, state: "created", number: pipelines });
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
  await new Promise((resolve) => setTimeout(resolve, started.interval * 1000 + 100));
  const granted = await send("POST", "/v1/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: started.device_code,
  });
  bearer = { authorization: `Bearer ${DeviceTokenSchema.parse(await granted.json()).access_token}` };
  const [persona] = PersonaSchema.array().parse(await (await send("GET", "/v1/personas", undefined, bearer)).json());
  assert.ok(persona);
  personaId = persona.personaId;
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
    `INSERT INTO github_installations (installation_id, tenant_id, account_login, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Active', ?, ?)`,
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

const startCircleCI = () =>
  send("POST", "/v1/prebuilds", { repository: REPOSITORY, personaId, provider: "CircleCI", rebuild: true }, bearer);

const started = async () => {
  const response = await startCircleCI();
  assert.equal(response.status, 200, await response.clone().text());
  return PrebuildSchema.parse(await response.json());
};

const readPrebuild = async (prebuildId: string) =>
  PrebuildSchema.parse(await (await send("GET", `/v1/prebuilds/${prebuildId}`, undefined, bearer)).json());

const failure = async (prebuildId: string) =>
  PrebuildFailureSchema.parse(
    await (await send("GET", `/v1/prebuilds/${prebuildId}/failure`, undefined, bearer)).json(),
  );

const signingSecret = (): string => String(webhooks.at(-1)?.["signing-secret"]);

const event = (pipelineId: string, status: string, workflow = "tumpel-prebuild", project = PROJECT) =>
  JSON.stringify({
    type: "workflow-completed",
    id: crypto.randomUUID(),
    happened_at: new Date().toISOString(),
    workflow: { id: "w1", name: workflow, status, url: `https://app.circleci.com/pipelines/${SLUG}/1/workflows/w1` },
    pipeline: { id: pipelineId, number: 1 },
    project: { id: project, name: "app", slug: SLUG },
    organization: { id: ORGANIZATION, name: "acme" },
  });

const deliver = (body: string, signature: string | null) =>
  server.fetch(`${origin}/v1/circleci-events/${tenantId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === null ? {} : { "circleci-signature": signature }),
    },
    body,
  });

const v1 = (body: string, secret = signingSecret()) => `v1=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("a binding registers a signed workflow-completed webhook on its project, and a start runs the definition and builds at once", async () => {
  const refused = await startCircleCI();
  assert.equal(refused.status, 409);
  assert.equal(ProblemSchema.parse(await refused.json()).code, "CircleCIProjectMissing");

  await addBinding();
  const hook = webhooks.at(-1);
  assert.deepEqual(hook?.events, ["workflow-completed"]);
  assert.deepEqual(hook?.scope, { id: PROJECT, type: "project" });
  assert.equal(hook?.url, `${origin}/v1/circleci-events/${tenantId}`);
  assert.match(signingSecret(), /^[0-9a-f]{64}$/);

  const prebuild = await started();
  assert.equal(prebuild.provider, "CircleCI");
  assert.equal(prebuild.status.state, "Building");
  assert.equal(prebuild.logUrl, `https://app.circleci.com/pipelines/${SLUG}/${pipelines}`);
  const run = z
    .object({
      definition_id: z.string(),
      config: z.unknown(),
      checkout: z.unknown(),
      parameters: z.record(z.string(), z.string()),
    })
    .parse(runs.at(-1));
  assert.equal(run.definition_id, DEFINITION);
  assert.deepEqual(run.config, { branch: "main" });
  assert.deepEqual(run.checkout, { branch: "main" });
  assert.equal(run.parameters.tumpel_prebuild_id, prebuild.prebuildId);
  assert.equal(run.parameters.tumpel_tenant_id, tenantId);
  assert.equal(run.parameters.tumpel_api_origin, origin);
  assert.equal(run.parameters.tumpel_image_digest, prebuild.guestImageDigest);
  assert.ok(Object.values(run.parameters).every((value) => value.length <= 512));
});

test("a trigger CircleCI answers without a pipeline is refused DispatchRefused and stores no prebuild", async () => {
  const before = PrebuildSchema.array().parse(
    await (await send("GET", `/v1/prebuilds?repository=${REPOSITORY}`, undefined, bearer)).json(),
  );
  runAnswer = () => ({ status: 200, body: { message: "Config has no workflow tumpel-prebuild." } });
  const response = await startCircleCI();
  runAnswer = null;
  assert.equal(response.status, 409);
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "DispatchRefused");
  assert.match(problem.detail, /created no pipeline: Config has no workflow tumpel-prebuild\./);
  const after = PrebuildSchema.array().parse(
    await (await send("GET", `/v1/prebuilds?repository=${REPOSITORY}`, undefined, bearer)).json(),
  );
  assert.equal(after.length, before.length);
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

test("a workflow-completed event is taken only with its binding's signature, ignored for an unknown pipeline, and fails the prebuild in Build or Upload", async () => {
  const failing = await started();
  const failingPipeline = `pipeline-${pipelines}`;
  const silent = await started();
  const silentPipeline = `pipeline-${pipelines}`;

  const unsigned = await deliver(event(failingPipeline, "failed"), null);
  assert.equal(unsigned.status, 403);
  assert.equal(ProblemSchema.parse(await unsigned.json()).code, "Forbidden");
  const forged = event(failingPipeline, "failed");
  assert.equal((await deliver(forged, v1(forged, "another-secret"))).status, 403);
  const elsewhere = event(failingPipeline, "failed", "tumpel-prebuild", "99999999-0000-4000-8000-000000000000");
  assert.equal((await deliver(elsewhere, v1(elsewhere))).status, 403);
  const strangerTenant = await server.fetch(`${origin}/v1/circleci-events/${crypto.randomUUID()}`, {
    method: "POST",
    headers: { "content-type": "application/json", "circleci-signature": v1(forged) },
    body: forged,
  });
  assert.equal(strangerTenant.status, 403);
  assert.equal((await readPrebuild(failing.prebuildId)).status.state, "Building");

  const unknown = event("pipeline-unknown", "failed");
  assert.equal((await deliver(unknown, v1(unknown))).status, 204);
  const otherWorkflow = event(failingPipeline, "failed", "test");
  assert.equal((await deliver(otherWorkflow, v1(otherWorkflow))).status, 204);
  assert.equal((await readPrebuild(failing.prebuildId)).status.state, "Building");

  const failed = event(failingPipeline, "failed");
  assert.equal((await deliver(failed, v1(failed))).status, 204);
  const build = await readPrebuild(failing.prebuildId);
  assert.ok(build.status.state === "Failed");
  assert.equal(build.status.phase, "Build");
  assert.equal(build.logUrl, `https://app.circleci.com/pipelines/${SLUG}/1/workflows/w1`);
  assert.match((await failure(failing.prebuildId)).detail, /ended failed/);

  const succeeded = event(silentPipeline, "success");
  assert.equal((await deliver(succeeded, v1(succeeded))).status, 204);
  const upload = await readPrebuild(silent.prebuildId);
  assert.ok(upload.status.state === "Failed");
  assert.equal(upload.status.phase, "Upload");
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

test("a start whose pipeline parameter is over 512 characters is refused and triggers no pipeline", async () => {
  const host = Array.from({ length: 9 }, () => "a".repeat(60)).join(".");
  const before = runs.length;
  const response = await server.fetch(`http://${host}.test/v1/prebuilds`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", ...bearer },
    body: JSON.stringify({ repository: REPOSITORY, personaId, provider: "CircleCI", rebuild: true }),
  });
  assert.equal(response.status, 409, await response.clone().text());
  const problem = ProblemSchema.parse(await response.json());
  assert.equal(problem.code, "DispatchRefused");
  assert.match(problem.detail, /tumpel_api_origin is \d+ characters/);
  assert.equal(runs.length, before);
});

const OTHER_ORGANIZATION = "99999999-1111-4222-8333-444444444444";
const LAYER = Buffer.from("circleci layer");
const DIGEST = createHash("sha256").update(LAYER).digest("hex");

const jobToken = (
  pipelineId: string,
  jobId: string,
  claims: Record<string, unknown> = {},
  organization = ORGANIZATION,
  key: KeyObject = circle.privateKey,
): string => {
  const now = nowSeconds();
  return signed(
    { alg: "RS256", kid: CIRCLE_KID, typ: "JWT" },
    {
      iss: `${fakeOrigin}/oidc/org/${organization}`,
      aud: origin,
      sub: `org/${organization}/project/${PROJECT}/user/u1`,
      iat: now,
      nbf: now,
      exp: now + 300,
      "oidc.circleci.com/project-id": PROJECT,
      "oidc.circleci.com/pipeline-id": pipelineId,
      "oidc.circleci.com/job-id": jobId,
      "oidc.circleci.com/vcs-origin": "github.com/acme/app",
      "oidc.circleci.com/vcs-ref": "refs/heads/main",
      "oidc.circleci.com/ssh-rerun": false,
      ...claims,
    },
    key,
  );
};

const uploadStart = (prebuildId: string, token: string) =>
  send(
    "POST",
    `/v1/prebuilds/${prebuildId}/uploads`,
    { tenantId, layerDigest: DIGEST, layerSizeBytes: LAYER.length },
    { authorization: `Bearer ${token}` },
  );

const uploadComplete = (prebuildId: string, token: string) =>
  send("POST", `/v1/prebuilds/${prebuildId}/uploads/complete`, { tenantId }, { authorization: `Bearer ${token}` });

const refusal = async (response: { status: number; json(): Promise<unknown> }) => {
  const problem = ProblemSchema.parse(await response.json());
  return `${response.status} ${problem.code} ${problem.title}`;
};

test("a CircleCI job token takes the upload of its own pipeline from one job, and complete moves it to Converting", async () => {
  const prebuild = await started();
  const pipelineId = `pipeline-${pipelines}`;
  const first = await uploadStart(prebuild.prebuildId, jobToken(pipelineId, "job-upload"));
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await uploadStart(prebuild.prebuildId, jobToken(pipelineId, "job-upload"))).status, 200);
  assert.equal(
    await refusal(await uploadStart(prebuild.prebuildId, jobToken(pipelineId, "job-build"))),
    "403 JobTokenMismatch Job token refused: job-id",
  );
  const env = await server.getWorker<Bindings>().getEnv();
  await env.STORE.put(`${tenantId}/prebuilds/${prebuild.prebuildId}/layers/${DIGEST}`, LAYER);
  assert.equal(
    await refusal(await uploadComplete(prebuild.prebuildId, jobToken(pipelineId, "job-build"))),
    "403 JobTokenMismatch Job token refused: job-id",
  );
  const completed = await uploadComplete(prebuild.prebuildId, jobToken(pipelineId, "job-upload"));
  assert.equal(completed.status, 200, await completed.clone().text());
  assert.equal(PrebuildSchema.parse(await completed.json()).status.state, "Converting");
});

test("the upload exchange refuses a CircleCI token of another organization, repository, project, pipeline, ref or an SSH rerun", async () => {
  const prebuild = await started();
  const pipelineId = `pipeline-${pipelines}`;
  const attempt = async (token: string) => refusal(await uploadStart(prebuild.prebuildId, token));
  assert.equal(
    await attempt(jobToken(pipelineId, "job-upload", {}, ORGANIZATION, stranger.privateKey)),
    "401 JobTokenRefused Job token refused: signature",
  );
  assert.equal(
    await attempt(jobToken(pipelineId, "job-upload", { aud: "https://elsewhere.test" })),
    "401 JobTokenRefused Job token refused: aud",
  );
  assert.equal(
    await attempt(jobToken(pipelineId, "job-upload", {}, OTHER_ORGANIZATION)),
    "404 NotFound No such prebuild",
  );
  assert.equal(
    await attempt(jobToken(pipelineId, "job-upload", { "oidc.circleci.com/vcs-origin": "github.com/acme/other" })),
    "404 NotFound No such prebuild",
  );
  assert.equal(
    await attempt(jobToken(pipelineId, "job-upload", { "oidc.circleci.com/project-id": OTHER_ORGANIZATION })),
    "403 JobTokenMismatch Job token refused: project-id",
  );
  assert.equal(
    await attempt(jobToken("pipeline-elsewhere", "job-upload")),
    "403 JobTokenMismatch Job token refused: pipeline-id",
  );
  assert.equal(
    await attempt(jobToken(pipelineId, "job-upload", { "oidc.circleci.com/vcs-ref": "refs/heads/feature" })),
    "403 JobTokenMismatch Job token refused: vcs-ref",
  );
  assert.equal(
    await attempt(jobToken(pipelineId, "job-upload", { "oidc.circleci.com/ssh-rerun": true })),
    "403 JobTokenMismatch Job token refused: ssh-rerun",
  );
  assert.equal((await readPrebuild(prebuild.prebuildId)).status.state, "Building");
});

test("a pipeline that checked out another commit than the start read fails its prebuild in phase Dispatch", async () => {
  const prebuild = await started();
  const pipelineId = `pipeline-${pipelines}`;
  revisions.set(pipelineId, "d".repeat(40));
  assert.equal(
    await refusal(await uploadStart(prebuild.prebuildId, jobToken(pipelineId, "job-upload"))),
    "409 PrebuildNotUploading Prebuild not uploading",
  );
  const moved = await readPrebuild(prebuild.prebuildId);
  assert.ok(moved.status.state === "Failed");
  assert.equal(moved.status.phase, "Dispatch");
  assert.match((await failure(prebuild.prebuildId)).detail, /checked out commit d{40}/);
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
