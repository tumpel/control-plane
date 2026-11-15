import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  PersonaSchema,
  PrebuildSchema,
  ProblemSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import type { z } from "zod";

const AUDIENCE = "tumpel-prebuilds-e2e";
const KID = "prebuilds-e2e-key";
const EMAIL = "prebuilds@example.test";
const REPOSITORY = "https://github.com/acme/app.git";

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

const deviceToken = async (): Promise<string> => {
  const started = DeviceAuthorizationSchema.parse(
    await (await send("POST", "/v1/device/code", { device_name: "prebuilds e2e" })).json(),
  );
  const browser = { "cf-access-jwt-assertion": assertion(), origin };
  assert.equal((await send("POST", "/v1/device/approve", { userCode: started.user_code }, browser)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, started.interval * 1000 + 100));
  const granted = await send("POST", "/v1/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: started.device_code,
  });
  assert.equal(granted.status, 200);
  return DeviceTokenSchema.parse(await granted.json()).access_token;
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
        vars: { ACCESS_ISSUER: issuer, ACCESS_AUD: AUDIENCE, SECRETS_KEK: Buffer.alloc(32, 7).toString("base64") },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  const identity = { gitAuthorName: "Prebuilds", gitAuthorEmail: EMAIL };
  const browser = { "cf-access-jwt-assertion": assertion(), origin };
  assert.equal((await send("POST", "/v1/tenants", { name: "Prebuilds", ...identity }, browser)).status, 200);
  bearer = { authorization: `Bearer ${await deviceToken()}` };
});

after(async () => {
  await server?.close();
  certs?.close();
});

test("a prebuild start with no build provider connected is refused NoBuildProvider and stores nothing", async () => {
  const [persona] = await rest(PersonaSchema.array(), "GET", "/v1/personas");
  assert.ok(persona);
  const start = { repository: REPOSITORY, personaId: persona.personaId, rebuild: false };
  const problem = await refused("POST", "/v1/prebuilds", start, 409);
  assert.equal(problem.code, "NoBuildProvider");
  assert.match(problem.detail, /acme\/app/);
  assert.notEqual(problem.fix, "");
  assert.equal((await refused("POST", "/v1/prebuilds", { ...start, rebuild: true }, 409)).code, "NoBuildProvider");
  assert.equal(
    (await refused("POST", "/v1/prebuilds", { ...start, repository: "https://example.test/app.git" }, 422)).code,
    "InvalidRequest",
  );
  assert.equal((await refused("POST", "/v1/prebuilds", { ...start, personaId: "missing" }, 404)).code, "NotFound");
  const query = new URLSearchParams({ repository: REPOSITORY });
  assert.deepEqual(await rest(PrebuildSchema.array(), "GET", `/v1/prebuilds?${query}`), []);
  assert.equal((await refused("GET", "/v1/prebuilds/missing", undefined, 404)).code, "NotFound");
  assert.equal((await refused("GET", "/v1/prebuilds/missing/failure", undefined, 404)).code, "NotFound");
});
