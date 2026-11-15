import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  GitHubActionsConnectionLinkSchema,
  PersonaSchema,
  PrebuildSchema,
  PrebuildUploadGrantSchema,
  ProblemSchema,
  WhoamiSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";

const ACCESS_AUD = "tumpel-prebuild-uploads-e2e";
const ACCESS_KID = "access-key";
const JOB_KID = "github-job-key";
const EMAIL = "uploads@example.test";
const CALLER_WORKFLOW = ".github/workflows/tumpel-prebuild.yml";
const HEAD_SHA = "c".repeat(40);
const RUN = { runId: 42, headSha: HEAD_SHA };

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = rsa();
const job = rsa();
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

type Store = { put(key: string, value: Uint8Array): Promise<unknown> };
type TenantStub = {
  recordDispatchedPrebuild(tenantId: string, dispatch: unknown, now: number): Promise<unknown>;
};
type Bindings = { STORE: Store; TENANT: { getByName(name: string): TenantStub } };

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

before(async () => {
  keys = createServer((request, response) => {
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
          SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
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
            prebuildDispatchBudgetSeconds: 600,
            prebuildBuildBudgetSeconds: 3600,
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
    [{ run_id: "43" }, "run_id"],
    [{ sha: "d".repeat(40) }, "sha"],
  ];
  for (const [claims, check] of mismatches) {
    const problem = await refusal(uploadsPath, exchange, jobToken(claims), 403);
    assert.equal(problem.code, "JobTokenMismatch");
    assert.equal(problem.title, `Job token refused: ${check}`);
  }

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
  const repeated = await send("POST", uploadsPath, exchange, asJob(jobToken()));
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
