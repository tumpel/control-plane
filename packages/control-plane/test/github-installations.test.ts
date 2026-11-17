import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DeviceAuthorizationSchema, DeviceTokenSchema, GitHubInstallationSchema, WhoamiSchema } from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { generateDataKey, seal } from "../src/envelope.ts";
import { linkInstallation } from "../src/github-store.ts";
import { workersSecretKeyStore } from "../src/key-store.ts";
import { pollInterval, TEST_SETTINGS } from "./timing.ts";

const ACCESS_AUD = "tumpel-github-installations-e2e";
const ACCESS_KID = "access-key";
const EMAIL = "installations@example.test";
const SECRETS_KEK = Buffer.alloc(32, 7).toString("base64");
const WEBHOOK_SECRET = "github-installations-webhook-secret";
const INSTALLATION_ID = 77;

const rsa = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const access = rsa();
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
let bearer: Record<string, string>;
let tenantId: string;

type Database = { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };

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

before(async () => {
  keys = createServer((request, response) => {
    const found = request.url === "/cdn-cgi/access/certs";
    response.writeHead(found ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(found ? { keys: [publicJwk(access.publicKey, ACCESS_KID)] } : {}));
  });
  await new Promise<void>((resolve) => keys.listen(0, "127.0.0.1", resolve));
  keysOrigin = `http://127.0.0.1:${(keys.address() as AddressInfo).port}`;
  server = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          ACCESS_ISSUER: keysOrigin,
          ACCESS_AUD,
          DASHBOARD_ORIGIN: "https://app.tumpel.test",
          SECRETS_KEK,
          TUMPEL_SETTINGS: TEST_SETTINGS,
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  const browser = { "cf-access-jwt-assertion": assertion(), origin };
  const created = await send("POST", "/v1/tenants", { name: "Installations" }, browser);
  assert.equal(created.status, 200);
  tenantId = WhoamiSchema.parse(await created.json()).tenant.tenantId;
  const started = DeviceAuthorizationSchema.parse(
    await (await send("POST", "/v1/device/code", { device_name: "installations e2e" })).json(),
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
  const env = await server.getWorker<{ DB: Database }>().getEnv();
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
    `INSERT INTO github_installations (installation_id, tenant_id, account_login, account_type, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Organization', 'Active', ?, ?)`,
  )
    .bind(INSTALLATION_ID, tenantId, "acme", Date.now(), Date.now())
    .run();
});

after(async () => {
  await server?.close();
  keys?.close();
});

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
  const env = await server.getWorker<{ DB: Database }>().getEnv();
  await env.DB.prepare(
    `INSERT INTO github_installations (installation_id, tenant_id, account_login, account_type, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Organization', 'Active', ?, ?)`,
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
