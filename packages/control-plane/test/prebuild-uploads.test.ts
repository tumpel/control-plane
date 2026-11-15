import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, mock, test } from "node:test";
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
import { verifyJobToken } from "../src/job-token.ts";

const ACCESS_AUD = "tumpel-prebuild-uploads-e2e";
const ACCESS_KID = "access-key";
const JOB_KID = "github-job-key";
const EMAIL = "uploads@example.test";
const CALLER_WORKFLOW = ".github/workflows/tumpel-prebuild.yml";

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = rsa();
const job = rsa();
const stranger = rsa();
const publicJwk = (key: KeyObject, kid: string) => ({
  ...key.export({ format: "jwk" }),
  kid,
  alg: "RS256",
  use: "sig",
});

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

const signed = (header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject): string => {
  const body = `${encode(header)}.${encode(claims)}`;
  const signature =
    header.alg === "ES256"
      ? sign("SHA256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" })
      : sign("RSA-SHA256", Buffer.from(body), key);
  return `${body}.${signature.toString("base64url")}`;
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

test("a job token is accepted when its issuer signed it for this audience, and refused naming the failed check", async () => {
  const issuer = "https://jobs.example.test";
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keys = [publicJwk(job.publicKey, "rsa-key"), { ...ec.publicKey.export({ format: "jwk" }), kid: "ec-key" }];
  const fetched: string[] = [];
  const fetchSpy = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({ issuer, jwks_uri: `${issuer}/keys` });
    }
    if (url === `${issuer}/keys`) return Response.json({ keys: [...keys, { kty: "OKP", kid: "skipped" }] });
    return new Response("not found", { status: 404 });
  });
  const audience = "https://api.example.test";
  const claims = { iss: issuer, aud: audience, exp: nowSeconds() + 300, repository: "acme/app" };
  const rs256 = (overrides: Record<string, unknown>, kid = "rsa-key", key = job.privateKey) =>
    signed({ alg: "RS256", kid, typ: "JWT" }, { ...claims, ...overrides }, key);

  const accepted = await verifyJobToken(rs256({}), issuer, audience, Date.now());
  assert.ok(accepted.ok);
  assert.equal(accepted.claims.repository, "acme/app");
  assert.deepEqual(fetched, [`${issuer}/.well-known/openid-configuration`, `${issuer}/keys`]);

  const es256 = signed({ alg: "ES256", kid: "ec-key" }, { ...claims, aud: [audience, "other"] }, ec.privateKey);
  assert.ok((await verifyJobToken(es256, issuer, audience, Date.now())).ok);
  assert.equal(fetched.length, 2);

  const refusals: [string, string][] = [
    [rs256({ aud: "https://github.com/acme" }), "aud"],
    [rs256({ exp: nowSeconds() - 120 }), "exp"],
    [rs256({ iss: "https://other.example.test" }), "iss"],
    [rs256({}, "unknown-key"), "kid"],
    [rs256({}, "rsa-key", stranger.privateKey), "signature"],
    [signed({ alg: "ES256", kid: "rsa-key" }, claims, ec.privateKey), "signature"],
    [signed({ alg: "HS256", kid: "rsa-key" }, claims, job.privateKey), "token"],
    ["not-a-jwt", "token"],
  ];
  for (const [token, check] of refusals) {
    const refused = await verifyJobToken(token, issuer, audience, Date.now());
    assert.ok(!refused.ok, check);
    assert.equal(refused.check, check);
  }
  assert.equal(fetched.length, 2, "an unknown kid inside the refresh floor fetches no keys again");
  fetchSpy.mock.restore();
});

let keys: Server;
let server: TestHarness;
let origin: string;
let keysOrigin: string;
let githubIssuer: string;
let bearer: Record<string, string>;
let tenantId: string;
let personaId: string;

type Store = { put(key: string, value: Uint8Array): Promise<unknown> };
type TenantStub = { recordDispatchedPrebuild(tenantId: string, dispatch: unknown, now: number): Promise<unknown> };
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

const jobToken = (overrides: Record<string, unknown> = {}, kid = JOB_KID): string =>
  signed(
    { alg: "RS256", kid, typ: "JWT" },
    {
      iss: githubIssuer,
      aud: origin,
      exp: nowSeconds() + 300,
      repository: "Acme/App",
      workflow_ref: `Acme/App/${CALLER_WORKFLOW}@refs/heads/main`,
      job_workflow_ref: "tumpel/workflows/.github/workflows/prebuild.yml@refs/tags/v1",
      run_id: "42",
      ...overrides,
    },
    job.privateKey,
  );

const asJob = (token: string) => ({ authorization: `Bearer ${token}` });

before(async () => {
  keys = createServer((request, response) => {
    const routes: Record<string, unknown> = {
      "/cdn-cgi/access/certs": { keys: [publicJwk(access.publicKey, ACCESS_KID)] },
      "/github/.well-known/openid-configuration": { issuer: githubIssuer, jwks_uri: `${githubIssuer}/jwks` },
      "/github/jwks": { keys: [publicJwk(job.publicKey, JOB_KID)] },
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
            buildProviderIssuers: {
              gitHubActions: githubIssuer,
              namespaceBuilds: "https://federation.namespaceapis.com",
            },
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
    { name: "Uploads", gitAuthorName: "Uploads", gitAuthorEmail: EMAIL },
    browser,
  );
  assert.equal(created.status, 200);
  tenantId = WhoamiSchema.parse(await created.json()).tenant.tenantId;
  const started = DeviceAuthorizationSchema.parse(
    await (await send("POST", "/v1/device/code", { device_name: "uploads e2e" })).json(),
  );
  assert.equal((await send("POST", "/v1/device/approve", { userCode: started.user_code }, browser)).status, 200);
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
        personaId,
        key: { repository: "https://github.com/acme/app", inputDigest: digest, guestImageDigest: digest },
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

test("a build job exchanges its GitHub token for checked upload URLs, and completing the upload moves the prebuild to Converting", async () => {
  const prebuild = await dispatched(tenantId);
  assert.equal(prebuild.status.state, "Dispatched");
  const layer = new TextEncoder().encode("layer bytes");
  const config = new TextEncoder().encode("{}");
  const manifest = new TextEncoder().encode('{"layers":[]}');
  const uploadsPath = `/v1/prebuilds/${prebuild.prebuildId}/uploads`;
  const exchange = {
    tenantId,
    blobs: [
      { digest: sha256(layer), sizeBytes: layer.length },
      { digest: sha256(config), sizeBytes: config.length },
    ],
    manifest: { digest: sha256(manifest), sizeBytes: manifest.length },
  };

  const answered = await send("POST", uploadsPath, exchange, asJob(jobToken()));
  assert.equal(answered.status, 200, await answered.clone().text());
  const uploads = PrebuildUploadGrantSchema.parse(await answered.json());
  assert.equal(uploads.prebuildId, prebuild.prebuildId);
  assert.match(
    uploads.blobs[0]?.uploadUrl ?? "",
    new RegExp(`/${tenantId}/prebuilds/${prebuild.prebuildId}/blobs/${sha256(layer)}\\?`),
  );
  assert.match(uploads.blobs[0]?.uploadUrl ?? "", /X-Tumpel-Checksum=/);
  assert.match(
    uploads.manifest.uploadUrl,
    new RegExp(`/${tenantId}/prebuilds/${prebuild.prebuildId}/manifest\\.json\\?`),
  );
  const lifetime = Date.parse(uploads.uploadExpiresAt) - Date.now();
  assert.ok(lifetime > 890_000 && lifetime <= 900_000, `the URLs live the upload budget, not ${lifetime} ms`);

  const checks: [string | null, number, string][] = [
    [null, 401, "token"],
    [jobToken({ aud: "https://github.com/Acme" }), 401, "aud"],
    [jobToken({ exp: nowSeconds() - 120 }), 401, "exp"],
    [jobToken({}, "unknown-key"), 401, "kid"],
    [jobToken({ repository: "acme/other" }), 403, "repository"],
    [jobToken({ workflow_ref: "Acme/App/.github/workflows/ci.yml@refs/heads/main" }), 403, "workflow_ref"],
  ];
  for (const [token, status, check] of checks) {
    const problem = await refusal(uploadsPath, exchange, token, status);
    assert.equal(problem.code, status === 401 ? "JobTokenRefused" : "JobTokenMismatch");
    assert.equal(problem.title, `Job token refused: ${check}`);
  }

  const elsewhere = await dispatched(crypto.randomUUID());
  const foreign = await refusal(`/v1/prebuilds/${elsewhere.prebuildId}/uploads`, exchange, jobToken(), 404);
  assert.equal(foreign.code, "NotFound");

  const completion = { tenantId, layerDigest: sha256(layer), layerSizeBytes: layer.length };
  const early = await refusal(`${uploadsPath}/complete`, completion, jobToken(), 409);
  assert.equal(early.code, "LayerNotUploaded");
  assert.equal(
    (await refusal(`${uploadsPath}/complete`, completion, jobToken({ repository: "acme/other" }), 403)).code,
    "JobTokenMismatch",
  );

  const env = await server.getWorker<Bindings>().getEnv();
  await env.STORE.put(`${tenantId}/prebuilds/${prebuild.prebuildId}/blobs/${sha256(layer)}`, layer);
  const completed = await send("POST", `${uploadsPath}/complete`, completion, asJob(jobToken()));
  assert.equal(completed.status, 200, await completed.clone().text());
  const converting = PrebuildSchema.parse(await completed.json());
  assert.equal(converting.status.state, "Converting");
  assert.ok(converting.status.state === "Converting");
  assert.equal(converting.status.layerDigest, sha256(layer));
  assert.equal(converting.status.layerSizeBytes, layer.length);

  const read = await send("GET", `/v1/prebuilds/${prebuild.prebuildId}`, undefined, bearer);
  assert.deepEqual(PrebuildSchema.parse(await read.json()).status, converting.status);
  assert.equal((await refusal(uploadsPath, exchange, jobToken(), 409)).code, "PrebuildNotUploading");
  assert.equal((await refusal(`${uploadsPath}/complete`, completion, jobToken(), 409)).code, "PrebuildNotUploading");
});
