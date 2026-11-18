import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DeviceAuthorizationSchema, DeviceSchema, ProblemSchema, WhoamiSchema } from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { TEST_SETTINGS } from "../timing.ts";

const AUDIENCE = "tumpel-proof-e2e";
const KID = "proof-e2e-key";
const PROOF_CLIENT_ID = "0123456789abcdef.access";
const PROOF_CLIENT_SECRET = "proof-secret-never-printed-0123456789abcdef";
const OTHER_COMMON_NAME = "fedcba9876543210.access";
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TUMPEL = join(ROOT, ".tmp", "release-binaries", "tumpel");
const BROWSER_PATHS = ["/device", "/v1/tenants", "/v1/device/approve", "/v1/device/deny", "/oauth/consent"];

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

let certs: Server;
let access: Server;
let server: TestHarness;
let origin: string;
let accessOrigin: string;
let issuer: string;
let scratch: string;

const serviceTokenAssertion = (commonName: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({
    type: "app",
    iss: issuer,
    aud: [AUDIENCE],
    common_name: commonName,
    sub: "",
    iat: now,
    nbf: now,
    exp: now + 600,
  });
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`;
};

const proofTenantId = (commonName: string): string => {
  const hex = createHash("sha256").update(`tenant:${commonName}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  server.fetch(`${origin}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const actAsAccess = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const url = new URL(request.url ?? "/", accessOrigin);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string" && name !== "host" && !name.startsWith("cf-access-")) headers[name] = value;
  }
  if (BROWSER_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) {
    const signedIn =
      request.headers["cf-access-client-id"] === PROOF_CLIENT_ID &&
      request.headers["cf-access-client-secret"] === PROOF_CLIENT_SECRET;
    if (!signedIn) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    headers["cf-access-jwt-assertion"] = serviceTokenAssertion(PROOF_CLIENT_ID);
  }
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
  const answered = await server.fetch(`${origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
  response.writeHead(answered.status, Object.fromEntries(answered.headers));
  response.end(Buffer.from(await answered.arrayBuffer()));
};

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

const tumpel = (args: string[], extra: Record<string, string> = {}): Promise<Finished> => {
  const child = spawn(TUMPEL, args, {
    env: { PATH: process.env.PATH ?? "", HOME: scratch, TUMPEL_ENV_FILE: join(scratch, "env"), ...extra },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
};

before(async () => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  scratch = mkdtempSync(join(ROOT, ".tmp", "proof-e2e-"));
  certs = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => certs.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(certs.address() as AddressInfo).port}`;
  server = createTestHarness({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          TUMPEL_SETTINGS: TEST_SETTINGS,
          ACCESS_ISSUER: issuer,
          ACCESS_AUD: AUDIENCE,
          ACCESS_PROOF_COMMON_NAME: PROOF_CLIENT_ID,
          SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
          DASHBOARD_ORIGIN: "https://app.tumpel.test",
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  access = createServer((request, response) => {
    actAsAccess(request, response).catch((error: unknown) => {
      response.writeHead(502).end(String(error));
    });
  });
  await new Promise<void>((resolve) => access.listen(0, "127.0.0.1", resolve));
  accessOrigin = `http://127.0.0.1:${(access.address() as AddressInfo).port}`;
});

after(async () => {
  await server?.close();
  certs?.close();
  access?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("the proof's service token approves and denies device codes and is refused where a person is required", async () => {
  const proof = { "cf-access-jwt-assertion": serviceTokenAssertion(PROOF_CLIENT_ID) };
  const start = async (name: string) =>
    DeviceAuthorizationSchema.parse(await (await postJson("/v1/device/code", { device_name: name })).json());

  const approvedCode = await start("proof approve");
  const approved = await postJson(
    "/v1/device/approve",
    { userCode: approvedCode.user_code, tenantId: proofTenantId(PROOF_CLIENT_ID) },
    proof,
  );
  assert.equal(approved.status, 200);
  const device = DeviceSchema.parse(await approved.json());
  assert.equal(device.tenantId, proofTenantId(PROOF_CLIENT_ID));

  const again = await start("proof approve again");
  const second = DeviceSchema.parse(
    await (
      await postJson(
        "/v1/device/approve",
        { userCode: again.user_code, tenantId: proofTenantId(PROOF_CLIENT_ID) },
        proof,
      )
    ).json(),
  );
  assert.deepEqual([second.tenantId, second.principalId], [device.tenantId, device.principalId]);

  const deniedCode = await start("proof deny");
  assert.equal((await postJson("/v1/device/deny", { userCode: deniedCode.user_code }, proof)).status, 204);

  const stranger = await start("stranger");
  const other = { "cf-access-jwt-assertion": serviceTokenAssertion(OTHER_COMMON_NAME) };
  const refusedOther = await postJson(
    "/v1/device/approve",
    { userCode: stranger.user_code, tenantId: proofTenantId(OTHER_COMMON_NAME) },
    other,
  );
  assert.equal(refusedOther.status, 403);
  assert.equal(ProblemSchema.parse(await refusedOther.json()).title, "Unknown service token");

  const signUp = await postJson("/v1/tenants", { name: "Proof" }, proof);
  assert.equal(signUp.status, 401);
  assert.match(ProblemSchema.parse(await signUp.json()).detail, /service token signs in only to approve or deny/);

  const page = await server.fetch(`${origin}/device?code=${stranger.user_code}`, { headers: proof });
  assert.equal(page.status, 401);
});

test("tumpel login approves its own code with the proof's service token and whoami names the proof tenant", async () => {
  const proofEnv = { TUMPEL_PROOF_CLIENT_ID: PROOF_CLIENT_ID, TUMPEL_PROOF_CLIENT_SECRET: PROOF_CLIENT_SECRET };
  const login = await tumpel(["login", "--endpoint", accessOrigin, "--name", "proof cli"], proofEnv);
  assert.equal(login.code, 0, login.stderr);
  for (const output of [login.stdout, login.stderr]) {
    assert.doesNotMatch(output, new RegExp(PROOF_CLIENT_SECRET));
    assert.doesNotMatch(output, new RegExp(PROOF_CLIENT_ID.replace(".", "\\.")));
  }

  const whoami = await tumpel(["whoami"]);
  assert.equal(whoami.code, 0, whoami.stderr);
  assert.equal(WhoamiSchema.parse(JSON.parse(whoami.stdout)).tenant.name, "Tumpel proof");

  const halfSet = await tumpel(["login", "--endpoint", accessOrigin], { TUMPEL_PROOF_CLIENT_ID: PROOF_CLIENT_ID });
  assert.notEqual(halfSet.code, 0);
  assert.match(halfSet.stderr, /set both TUMPEL_PROOF_CLIENT_ID and TUMPEL_PROOF_CLIENT_SECRET/);
});
