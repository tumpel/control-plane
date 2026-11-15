import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  PersonaSchema,
  PrebuildFailureSchema,
  PrebuildSchema,
  WhoamiSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { generateDataKey, seal } from "../src/envelope.ts";
import { workersSecretKeyStore } from "../src/key-store.ts";

const AUDIENCE = "tumpel-prebuild-runs-e2e";
const KID = "prebuild-runs-key";
const EMAIL = "runs@example.test";
const SECRETS_KEK = Buffer.alloc(32, 7).toString("base64");
const WEBHOOK_SECRET = "prebuild-runs-webhook-secret";
const INSTALLATION_ID = 77;
const HEAD_SHA = "c".repeat(40);
const DISPATCH_BUDGET_SECONDS = 3;
const BUILD_BUDGET_SECONDS = 3;

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = rsa();
const app = rsa();
const jwk = { ...access.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

type TenantStub = { recordDispatchedPrebuild(tenantId: string, dispatch: unknown, now: number): Promise<unknown> };
type Database = { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };
type Bindings = { DB: Database; TENANT: { getByName(name: string): TenantStub } };

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;
let bearer: Record<string, string>;
let tenantId: string;
let personaId: string;
let nextRun = 500;

const assertion = (): string => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], email: EMAIL, iat: now, nbf: now, exp: now + 600 });
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), access.privateKey).toString("base64url")}`;
};

const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  server.fetch(`${origin}${path}`, {
    method,
    redirect: "manual",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

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
          SECRETS_KEK,
          DASHBOARD_ORIGIN: "https://app.tumpel.test",
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
            prebuildDispatchBudgetSeconds: DISPATCH_BUDGET_SECONDS,
            prebuildBuildBudgetSeconds: BUILD_BUDGET_SECONDS,
            gitHubActionsIssuer: "https://token.actions.githubusercontent.com",
          },
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  const browser = { "cf-access-jwt-assertion": assertion(), origin };
  const created = await send(
    "POST",
    "/v1/tenants",
    { name: "Runs", gitAuthorName: "Runs", gitAuthorEmail: EMAIL },
    browser,
  );
  assert.equal(created.status, 200);
  tenantId = WhoamiSchema.parse(await created.json()).tenant.tenantId;
  const started = DeviceAuthorizationSchema.parse(
    await (await send("POST", "/v1/device/code", { device_name: "runs e2e" })).json(),
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
    "INSERT INTO github_installations (installation_id, tenant_id, account_login, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(INSTALLATION_ID, tenantId, "acme", Date.now())
    .run();
});

after(async () => {
  await server?.close();
  certs?.close();
});

const dispatched = async () => {
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

const deliver = async (runId: number, action: string, conclusion: string | null, headSha = HEAD_SHA) => {
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
  const response = await server.fetch(`${origin}/github/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "workflow_run", "x-hub-signature-256": signature },
    body,
  });
  assert.equal(response.status, 204, await response.text());
};

const read = async (prebuildId: string) =>
  PrebuildSchema.parse(await (await send("GET", `/v1/prebuilds/${prebuildId}`, undefined, bearer)).json());

const failure = async (prebuildId: string) => {
  const response = await send("GET", `/v1/prebuilds/${prebuildId}/failure`, undefined, bearer);
  assert.equal(response.status, 200, await response.clone().text());
  return PrebuildFailureSchema.parse(await response.json());
};

const settled = async (prebuildId: string, state: string) => {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const prebuild = await read(prebuildId);
    if (prebuild.status.state === state || Date.now() > deadline) return prebuild;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

test("a dispatched run reports in_progress, the prebuild builds, and a failed run fails it in phase Build with the run's log", async () => {
  const { prebuild, runId } = await dispatched();
  await deliver(runId + 1000, "in_progress", null);
  assert.equal((await read(prebuild.prebuildId)).status.state, "Dispatched");
  await deliver(runId, "requested", null);
  await deliver(runId, "in_progress", null);
  assert.equal((await read(prebuild.prebuildId)).status.state, "Building");
  await deliver(runId, "completed", "failure");
  const failed = await read(prebuild.prebuildId);
  assert.ok(failed.status.state === "Failed");
  assert.equal(failed.status.phase, "Build");
  assert.equal(failed.logUrl, `https://github.com/acme/app/actions/runs/${runId}/attempts/1`);
  assert.match((await failure(prebuild.prebuildId)).detail, /ended failure/);
});

test("a run that starts on another commit than the start read fails in phase Dispatch, and a run that succeeds without an upload fails in phase Upload", async () => {
  const moved = await dispatched();
  await deliver(moved.runId, "in_progress", null, "d".repeat(40));
  const failed = await read(moved.prebuild.prebuildId);
  assert.ok(failed.status.state === "Failed");
  assert.equal(failed.status.phase, "Dispatch");

  const silent = await dispatched();
  await deliver(silent.runId, "in_progress", null);
  await deliver(silent.runId, "completed", "success");
  const unuploaded = await read(silent.prebuild.prebuildId);
  assert.ok(unuploaded.status.state === "Failed");
  assert.equal(unuploaded.status.phase, "Upload");
});

test("a run that never starts fails in phase Dispatch, and a build past its budget fails in phase Build", async () => {
  const waiting = await dispatched();
  const building = await dispatched();
  await deliver(building.runId, "in_progress", null);
  const unstarted = await settled(waiting.prebuild.prebuildId, "Failed");
  assert.ok(unstarted.status.state === "Failed");
  assert.equal(unstarted.status.phase, "Dispatch");
  assert.match((await failure(waiting.prebuild.prebuildId)).detail, /prebuildDispatchBudgetSeconds 3/);
  const overdue = await settled(building.prebuild.prebuildId, "Failed");
  assert.ok(overdue.status.state === "Failed");
  assert.equal(overdue.status.phase, "Build");
  assert.match((await failure(building.prebuild.prebuildId)).detail, /prebuildBuildBudgetSeconds 3/);
});
