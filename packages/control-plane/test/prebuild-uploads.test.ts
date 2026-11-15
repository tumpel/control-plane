import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  GitHubActionsConnectionLinkSchema,
  GitHubInstallationSchema,
  PersonaSchema,
  PrebuildFailureSchema,
  PrebuildSchema,
  PrebuildUploadGrantSchema,
  ProblemSchema,
  WhoamiSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { generateDataKey, seal } from "../src/envelope.ts";
import { linkInstallation } from "../src/github-store.ts";
import { workersSecretKeyStore } from "../src/key-store.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "./release-fixture.ts";

const ACCESS_AUD = "tumpel-prebuild-uploads-e2e";
const ACCESS_KID = "access-key";
const JOB_KID = "github-job-key";
const EMAIL = "uploads@example.test";
const CALLER_WORKFLOW = ".github/workflows/tumpel-prebuild.yml";
const HEAD_SHA = "c".repeat(40);
const RUN = { runId: 42, headSha: HEAD_SHA };
const SECRETS_KEK = Buffer.alloc(32, 7).toString("base64");
const WEBHOOK_SECRET = "prebuild-uploads-webhook-secret";
const INSTALLATION_ID = 77;
const BUDGET_SECONDS = 900;
const TREE_SHA = "1".repeat(40);
const DISPATCHED_RUN = 9001;

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = rsa();
const job = rsa();
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

let keys: Server;
let server: TestHarness;
let origin: string;
let keysOrigin: string;
let githubIssuer: string;
let bearer: Record<string, string>;
let tenantId: string;
let personaId: string;
let nextRun = 500;

type Store = { put(key: string, value: Uint8Array | string): Promise<unknown> };
type TenantStub = {
  recordDispatchedPrebuild(tenantId: string, dispatch: unknown, now: number): Promise<unknown>;
  prebuildDeadlineReached(tenantId: string, due: unknown): Promise<void>;
};
type Database = { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };
type Bindings = { DB: Database; STORE: Store; RELEASES: Store; TENANT: { getByName(name: string): TenantStub } };

const assertion = (): string => {
  const now = nowSeconds();
  return signed(
    { alg: "RS256", kid: ACCESS_KID, typ: "JWT" },
    { iss: keysOrigin, aud: [ACCESS_AUD], email: EMAIL, iat: now, nbf: now, exp: now + 600 },
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

const jobToken = (overrides: Record<string, unknown> = {}): string =>
  signed(
    { alg: "RS256", kid: JOB_KID, typ: "JWT" },
    {
      iss: githubIssuer,
      aud: origin,
      exp: nowSeconds() + 300,
      repository: "Acme/App",
      workflow_ref: `Acme/App/${CALLER_WORKFLOW}@refs/heads/main`,
      ref: "refs/heads/main",
      event_name: "workflow_dispatch",
      job_workflow_ref: "tumpel/workflows/.github/workflows/prebuild.yml@refs/tags/v1",
      run_id: "42",
      sha: HEAD_SHA,
      ...overrides,
    },
    job.privateKey,
  );

const asJob = (token: string) => ({ authorization: `Bearer ${token}` });

let inProgressDelivery: Promise<Response> | null = null;

const reply = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const fakeGitHub = async (request: IncomingMessage, response: ServerResponse, path: string) => {
  request.resume();
  if (request.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
    return reply(response, 201, {
      token: "installation-token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  if (path === "/repos/acme/app") return reply(response, 200, { default_branch: "main" });
  if (path === "/repos/acme/app/branches/main") {
    return reply(response, 200, { commit: { sha: HEAD_SHA, commit: { tree: { sha: TREE_SHA } } } });
  }
  if (path === `/repos/acme/app/git/trees/${TREE_SHA}`) {
    return reply(response, 200, { tree: [{ path: "package-lock.json", type: "blob", sha: "2".repeat(40) }] });
  }
  if (request.method === "POST" && path === "/repos/acme/app/actions/workflows/tumpel-prebuild.yml/dispatches") {
    inProgressDelivery = fetch(`${origin}/github/webhook`, runEvent(DISPATCHED_RUN, "in_progress", null, HEAD_SHA));
    await new Promise((resolve) => setTimeout(resolve, 500));
    return reply(response, 200, {
      workflow_run_id: DISPATCHED_RUN,
      run_url: `https://api.github.com/repos/acme/app/actions/runs/${DISPATCHED_RUN}`,
      html_url: `https://github.com/acme/app/actions/runs/${DISPATCHED_RUN}`,
    });
  }
  return reply(response, 404, { message: "Not Found" });
};

before(async () => {
  keys = createServer((request, response) => {
    if (request.url?.startsWith("/api/")) return void fakeGitHub(request, response, request.url.slice("/api".length));
    const routes: Record<string, unknown> = {
      "/cdn-cgi/access/certs": { keys: [publicJwk(access.publicKey, ACCESS_KID)] },
      "/github/.well-known/jwks": { keys: [publicJwk(job.publicKey, JOB_KID)] },
    };
    const body = routes[request.url ?? ""];
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((resolve) => keys.listen(0, "127.0.0.1", resolve));
  keysOrigin = `http://127.0.0.1:${(keys.address() as AddressInfo).port}`;
  githubIssuer = `${keysOrigin}/github`;
  server = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          ACCESS_ISSUER: keysOrigin,
          ACCESS_AUD,
          R2_STUB_ORIGIN: "https://r2.example.test",
          DASHBOARD_ORIGIN: "https://app.tumpel.test",
          GITHUB_API_ORIGIN: `${keysOrigin}/api`,
          SECRETS_KEK,
          TUMPEL_SETTINGS: {
            dispatchGrantTtlSeconds: 300,
            snapshotDelaySeconds: 30,
            snapshotDeadlineSeconds: 900,
            turnClaimBudgetSeconds: 60,
            turnImageFetchBudgetSeconds: 900,
            turnFirstLineBudgetSeconds: 120,
            turnTotalBudgetSeconds: 3600,
            transcriptChunkLines: 64,
            prebuildUploadBudgetSeconds: 900,
            prebuildDispatchBudgetSeconds: BUDGET_SECONDS,
            prebuildBuildBudgetSeconds: BUDGET_SECONDS,
            claudeSetupUrlBudgetSeconds: 300,
            claudeSetupCodeBudgetSeconds: 600,
            claudeSetupMintBudgetSeconds: 120,
            gitHubActionsIssuer: githubIssuer,
          },
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  const browser = { "cf-access-jwt-assertion": assertion(), origin };
  const created = await send("POST", "/v1/tenants", { name: "Uploads" }, browser);
  assert.equal(created.status, 200);
  tenantId = WhoamiSchema.parse(await created.json()).tenant.tenantId;
  const started = DeviceAuthorizationSchema.parse(
    await (await send("POST", "/v1/device/code", { device_name: "uploads e2e" })).json(),
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
  const connected = await send(
    "POST",
    "/v1/github-actions-connection/start",
    { accountLabel: "acme on GitHub Actions", callerWorkflow: CALLER_WORKFLOW },
    bearer,
  );
  GitHubActionsConnectionLinkSchema.parse(await connected.json());
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
      "tumpel-runs",
      "Iv1.runs",
      "acme",
      "https://github.com/apps/tumpel-runs",
      await keyStore.wrap(dataKey),
      await seal(dataKey, "runs-client-secret", "github-app/client_secret"),
      await seal(dataKey, WEBHOOK_SECRET, "github-app/webhook_secret"),
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
});

after(async () => {
  await server?.close();
  keys?.close();
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const dispatched = async (owner: string) => {
  const env = await server.getWorker<Bindings>().getEnv();
  const digest = "a".repeat(64);
  return PrebuildSchema.parse(
    await env.TENANT.getByName(owner).recordDispatchedPrebuild(
      owner,
      {
        prebuildId: crypto.randomUUID(),
        personaId,
        run: RUN,
        key: { repository: "https://github.com/acme/app", inputDigest: digest, guestImageDigest: digest },
        defaultBranch: "main",
        provider: "GitHubActions",
        logUrl: "https://github.com/acme/app/actions/runs/42",
      },
      Date.now(),
    ),
  );
};

const refusal = async (path: string, body: unknown, token: string | null, status: number) => {
  const response = await send("POST", path, body, token === null ? {} : asJob(token));
  assert.equal(response.status, status, `${path}: ${await response.clone().text()}`);
  return ProblemSchema.parse(await response.json());
};

test("a job of the dispatched run exchanges its GitHub token for one checked layer upload, which moves a Dispatched prebuild to Building, and completing it moves the prebuild to Converting", async () => {
  const prebuild = await dispatched(tenantId);
  assert.equal(prebuild.status.state, "Dispatched");
  const layer = new TextEncoder().encode("layer bytes");
  const uploadsPath = `/v1/prebuilds/${prebuild.prebuildId}/uploads`;
  const exchange = { tenantId, layerDigest: sha256(layer), layerSizeBytes: layer.length };
  const completion = { tenantId };

  const env = await server.getWorker<Bindings>().getEnv();

  const unknown = await refusal(uploadsPath, exchange, null, 401);
  assert.equal(unknown.code, "JobTokenRefused");
  assert.equal(unknown.title, "Job token refused: token");

  const notFound = await refusal(uploadsPath, exchange, jobToken({ repository: "acme/other" }), 404);
  assert.equal(notFound.code, "NotFound");
  const missingTenant = { ...exchange, tenantId: crypto.randomUUID() };
  assert.deepEqual(await refusal(uploadsPath, missingTenant, jobToken(), 404), notFound);
  const missingPrebuild = `/v1/prebuilds/${crypto.randomUUID()}/uploads`;
  assert.deepEqual(await refusal(missingPrebuild, exchange, jobToken(), 404), notFound);
  assert.deepEqual(
    await refusal(`${uploadsPath}/complete`, completion, jobToken({ repository: "acme/other" }), 404),
    notFound,
  );

  const mismatches: [Record<string, unknown>, string][] = [
    [{ workflow_ref: "Acme/App/.github/workflows/ci.yml@refs/heads/main" }, "workflow_ref"],
    [{ ref: "refs/heads/feature", workflow_ref: `Acme/App/${CALLER_WORKFLOW}@refs/heads/feature` }, "ref"],
    [{ event_name: "push" }, "event_name"],
    [{ job_workflow_ref: "Acme/App/.github/workflows/prebuild.yml@refs/tags/v1" }, "job_workflow_ref"],
    [{ job_workflow_ref: "tumpel/workflows/.github/workflows/prebuild.yml@refs/heads/main" }, "job_workflow_ref"],
    [{ job_workflow_ref: "tumpel/workflows/.github/workflows/prebuild.yml@refs/tags/v2.0.0" }, "job_workflow_ref"],
    [{ job_workflow_ref: "tumpel/workflows/.github/workflows/prebuild.yml@refs/tags/v1.2" }, "job_workflow_ref"],
    [{ run_id: "43" }, "run_id"],
    [{ sha: "d".repeat(40) }, "sha"],
  ];
  for (const [claims, check] of mismatches) {
    const problem = await refusal(uploadsPath, exchange, jobToken(claims), 403);
    assert.equal(problem.code, "JobTokenMismatch");
    assert.equal(problem.title, `Job token refused: ${check}`);
  }
  const shaPin = jobToken({ job_workflow_ref: `tumpel/workflows/.github/workflows/prebuild.yml@${"e".repeat(40)}` });
  assert.match((await refusal(uploadsPath, exchange, shaPin, 403)).fix, /commit SHA pin is refused/);

  const answered = await send("POST", uploadsPath, exchange, asJob(jobToken()));
  assert.equal(answered.status, 200, await answered.clone().text());
  const grant = PrebuildUploadGrantSchema.parse(await answered.json());
  const building = await send("GET", `/v1/prebuilds/${prebuild.prebuildId}`, undefined, bearer);
  assert.equal(PrebuildSchema.parse(await building.json()).status.state, "Building");
  assert.equal(grant.prebuildId, prebuild.prebuildId);
  assert.equal(grant.sha256, sha256(layer));
  const url = new URL(grant.url);
  assert.ok(
    url.pathname.endsWith(`/${tenantId}/prebuilds/${prebuild.prebuildId}/layers/${sha256(layer)}`),
    url.pathname,
  );
  assert.equal(url.searchParams.get("X-Tumpel-Method"), "PUT");
  assert.equal(url.searchParams.get("X-Tumpel-Checksum"), Buffer.from(sha256(layer), "hex").toString("base64"));
  assert.equal(url.searchParams.get("X-Tumpel-Length"), String(layer.length));
  const lifetime = Date.parse(grant.uploadExpiresAt) - Date.now();
  assert.ok(lifetime > 890_000 && lifetime <= 900_000, `the URL lives the upload budget, not ${lifetime} ms`);
  const releasePin = jobToken({ job_workflow_ref: "tumpel/workflows/.github/workflows/prebuild.yml@refs/tags/v1.4.2" });
  const repeated = await send("POST", uploadsPath, exchange, asJob(releasePin));
  assert.equal(repeated.status, 200, await repeated.clone().text());
  const other = { ...exchange, layerSizeBytes: layer.length + 1 };
  assert.equal((await refusal(uploadsPath, other, jobToken(), 409)).code, "Conflict");
  const oversized = { ...exchange, layerSizeBytes: 5 * 2 ** 30 + 1 };
  assert.equal((await refusal(uploadsPath, oversized, jobToken(), 400)).code, "InvalidRequest");

  assert.equal((await refusal(`${uploadsPath}/complete`, completion, jobToken(), 409)).code, "LayerNotUploaded");
  await env.STORE.put(`${tenantId}/prebuilds/${prebuild.prebuildId}/layers/${sha256(layer)}`, layer);
  const completed = await send("POST", `${uploadsPath}/complete`, completion, asJob(jobToken()));
  assert.equal(completed.status, 200, await completed.clone().text());
  const converting = PrebuildSchema.parse(await completed.json());
  assert.ok(converting.status.state === "Converting");
  assert.equal(converting.status.layerDigest, sha256(layer));
  assert.equal(converting.status.layerSizeBytes, layer.length);
  assert.equal(converting.status.uploadedAt, new Date(converting.updatedAt).toISOString());

  const read = await send("GET", `/v1/prebuilds/${prebuild.prebuildId}`, undefined, bearer);
  assert.deepEqual(PrebuildSchema.parse(await read.json()).status, converting.status);
  assert.equal((await refusal(uploadsPath, exchange, jobToken(), 409)).code, "PrebuildNotUploading");
  assert.equal((await refusal(`${uploadsPath}/complete`, completion, jobToken(), 409)).code, "PrebuildNotUploading");
});

const dispatchedRun = async () => {
  const env = await server.getWorker<Bindings>().getEnv();
  nextRun += 1;
  const prebuild = PrebuildSchema.parse(
    await env.TENANT.getByName(tenantId).recordDispatchedPrebuild(
      tenantId,
      {
        prebuildId: crypto.randomUUID(),
        personaId,
        key: {
          repository: "https://github.com/acme/app",
          inputDigest: "a".repeat(64),
          guestImageDigest: "b".repeat(64),
        },
        defaultBranch: "main",
        provider: "GitHubActions",
        run: { runId: nextRun, headSha: HEAD_SHA },
        logUrl: `https://github.com/acme/app/actions/runs/${nextRun}`,
      },
      Date.now(),
    ),
  );
  return { prebuild, runId: nextRun };
};

const signedDelivery = async (event: string, payload: unknown) => {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
  const response = await server.fetch(`${origin}/github/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": signature },
    body,
  });
  assert.equal(response.status, 204, await response.text());
};

const installations = async () =>
  GitHubInstallationSchema.array().parse(
    await (await send("GET", "/v1/github-connection/installations", undefined, bearer)).json(),
  );

test("a tenant holds an installation per account, a suspension changes only that one, and an uninstall drops only that one", async () => {
  const env = await server.getWorker<Bindings>().getEnv();
  await env.DB.prepare(
    `INSERT INTO github_installations (installation_id, tenant_id, account_login, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Active', ?, ?)`,
  )
    .bind(INSTALLATION_ID + 1, tenantId, "octo", Date.now(), Date.now())
    .run();
  const octo = { id: INSTALLATION_ID + 1, account: { id: 4242, login: "octo", type: "User" } };
  const sender = { id: 4242, login: "octo" };

  await signedDelivery("installation", { action: "suspend", installation: octo, sender });
  assert.deepEqual(
    (await installations()).map(({ accountLogin, status }) => [accountLogin, status]),
    [
      ["acme", "Active"],
      ["octo", "Suspended"],
    ],
  );

  await signedDelivery("installation", { action: "deleted", installation: octo, sender });
  assert.deepEqual(
    (await installations()).map((installation) => installation.accountLogin),
    ["acme"],
  );
});

test("connecting another account from Tumpel adds its installation and keeps the one the tenant held", async () => {
  const db = (await server.getWorker<{ DB: Parameters<typeof linkInstallation>[0] }>().getEnv()).DB;
  const kattebak = { id: 91, account: { id: 191, login: "kattebak", type: "User" as const } };
  const tumpel = { id: 92, account: { id: 192, login: "tumpel", type: "Organization" as const } };
  assert.equal((await linkInstallation(db, tenantId, kattebak, Date.now())).kind, "Linked");
  assert.equal((await linkInstallation(db, tenantId, tumpel, Date.now())).kind, "Linked");
  assert.equal((await linkInstallation(db, tenantId, kattebak, Date.now())).kind, "Linked");
  const held = (await installations()).map(({ installationId, accountLogin }) => [installationId, accountLogin]);
  assert.deepEqual(
    held.filter(([installationId]) => installationId === 91 || installationId === 92),
    [
      [91, "kattebak"],
      [92, "tumpel"],
    ],
  );
  assert.equal((await linkInstallation(db, "another-tenant", tumpel, Date.now())).kind, "OtherTenant");
});

const runEvent = (
  runId: number,
  action: string,
  conclusion: string | null,
  headSha: string,
): { method: string; headers: Record<string, string>; body: string } => {
  const body = JSON.stringify({
    action,
    installation: { id: INSTALLATION_ID },
    repository: { full_name: "acme/app" },
    workflow_run: {
      id: runId,
      head_sha: headSha,
      html_url: `https://github.com/acme/app/actions/runs/${runId}/attempts/1`,
      status: action === "completed" ? "completed" : action,
      conclusion,
    },
  });
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "workflow_run", "x-hub-signature-256": signature },
    body,
  };
};

const deliver = async (runId: number, action: string, conclusion: string | null, headSha = HEAD_SHA) => {
  const response = await server.fetch(`${origin}/github/webhook`, runEvent(runId, action, conclusion, headSha));
  assert.equal(response.status, 204, await response.text());
};

const readPrebuild = async (prebuildId: string) =>
  PrebuildSchema.parse(await (await send("GET", `/v1/prebuilds/${prebuildId}`, undefined, bearer)).json());

const failure = async (prebuildId: string) => {
  const response = await send("GET", `/v1/prebuilds/${prebuildId}/failure`, undefined, bearer);
  assert.equal(response.status, 200, await response.clone().text());
  return PrebuildFailureSchema.parse(await response.json());
};

test("a dispatched run reports in_progress, the prebuild builds, and a failed run fails it in phase Build with the run's log", async () => {
  const { prebuild, runId } = await dispatchedRun();
  await deliver(runId + 1000, "in_progress", null);
  assert.equal((await readPrebuild(prebuild.prebuildId)).status.state, "Dispatched");
  await deliver(runId, "requested", null);
  await deliver(runId, "in_progress", null);
  assert.equal((await readPrebuild(prebuild.prebuildId)).status.state, "Building");
  await deliver(runId, "completed", "failure");
  const failed = await readPrebuild(prebuild.prebuildId);
  assert.ok(failed.status.state === "Failed");
  assert.equal(failed.status.phase, "Build");
  assert.equal(failed.logUrl, `https://github.com/acme/app/actions/runs/${runId}/attempts/1`);
  assert.match((await failure(prebuild.prebuildId)).detail, /ended failure/);
});

test("a run that starts on another commit than the start read fails in phase Dispatch, and a run that succeeds without an upload fails in phase Upload", async () => {
  const moved = await dispatchedRun();
  await deliver(moved.runId, "in_progress", null, "d".repeat(40));
  const failed = await readPrebuild(moved.prebuild.prebuildId);
  assert.ok(failed.status.state === "Failed");
  assert.equal(failed.status.phase, "Dispatch");

  const silent = await dispatchedRun();
  await deliver(silent.runId, "in_progress", null);
  await deliver(silent.runId, "completed", "success");
  const unuploaded = await readPrebuild(silent.prebuild.prebuildId);
  assert.ok(unuploaded.status.state === "Failed");
  assert.equal(unuploaded.status.phase, "Upload");
});

test("a run that never starts fails in phase Dispatch, and a build past its budget fails in phase Build", async () => {
  const stub = (await server.getWorker<Bindings>().getEnv()).TENANT.getByName(tenantId);
  const waiting = await dispatchedRun();
  const building = await dispatchedRun();
  await deliver(building.runId, "in_progress", null);
  const reach = (name: string, prebuildId: string) =>
    stub.prebuildDeadlineReached(tenantId, { name, deadline: { prebuildId, at: Date.now() } });
  await reach("PrebuildDispatch", waiting.prebuild.prebuildId);
  await reach("PrebuildDispatch", building.prebuild.prebuildId);
  await reach("PrebuildBuild", building.prebuild.prebuildId);
  const unstarted = await readPrebuild(waiting.prebuild.prebuildId);
  assert.ok(unstarted.status.state === "Failed");
  assert.equal(unstarted.status.phase, "Dispatch");
  assert.match((await failure(waiting.prebuild.prebuildId)).detail, /prebuildDispatchBudgetSeconds 900/);
  const overdue = await readPrebuild(building.prebuild.prebuildId);
  assert.ok(overdue.status.state === "Failed");
  assert.equal(overdue.status.phase, "Build");
  assert.match((await failure(building.prebuild.prebuildId)).detail, /prebuildBuildBudgetSeconds 900/);
});

test("a run that reports in_progress before GitHub answers the dispatch still finds its run recorded and builds", async () => {
  const response = await send(
    "POST",
    "/v1/prebuilds",
    { repository: "https://github.com/acme/app", personaId, provider: "GitHubActions", rebuild: true },
    bearer,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const started = PrebuildSchema.parse(await response.json());
  assert.ok(inProgressDelivery !== null);
  assert.equal((await inProgressDelivery).status, 204);
  assert.equal(started.logUrl, `https://github.com/acme/app/actions/runs/${DISPATCHED_RUN}`);
  assert.equal((await readPrebuild(started.prebuildId)).status.state, "Building");
});
