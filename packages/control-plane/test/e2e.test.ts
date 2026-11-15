import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DeviceAuthorizationSchema,
  DeviceSchema,
  DeviceTokenSchema,
  OAuthClientSchema,
  OAuthErrorSchema,
  OAuthTokenSchema,
  PersonaSchema,
  ProblemSchema,
  WhoamiSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";

const AUDIENCE = "tumpel-e2e";
const KID = "e2e-key";
const EMAIL = "owner@example.test";
const CALLBACK = "https://client.example.test/callback";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

const base64Url = (bytes: Buffer): string => bytes.toString("base64url");

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;

const assertion = (email: string, claims: Record<string, unknown> = {}, key: KeyObject = privateKey): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(Buffer.from(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" })));
  const payload = base64Url(
    Buffer.from(JSON.stringify({ iss: issuer, aud: [AUDIENCE], email, iat: now, nbf: now, exp: now + 600, ...claims })),
  );
  const signature = base64Url(sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key));
  return `${header}.${payload}.${signature}`;
};

type HarnessInit = NonNullable<Parameters<TestHarness["fetch"]>[1]>;
type HarnessResponse = ReturnType<TestHarness["fetch"]>;

const call = (path: string, init: HarnessInit = {}): HarnessResponse =>
  server.fetch(`${origin}${path}`, { redirect: "manual", ...init });

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}): HarnessResponse =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const browser = (): Record<string, string> => ({ "cf-access-jwt-assertion": assertion(EMAIL), origin });

const form = (path: string, params: Record<string, string>): HarnessResponse =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

const oauthErrorOf = async (response: Awaited<HarnessResponse>): Promise<string> => {
  assert.equal(response.status, 400);
  return OAuthErrorSchema.parse(await response.json()).error;
};

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const mcp = (token: string, id: number, method: string, params: unknown = {}): HarnessResponse =>
  postJson("/mcp", { jsonrpc: "2.0", id, method, params }, token === "" ? {} : { authorization: `Bearer ${token}` });

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
          SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
          DASHBOARD_ORIGIN: "https://app.tumpel.test",
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
});

after(async () => {
  await server?.close();
  certs?.close();
});

test("a signed-in owner signs up, logs a device in, and is the same principal over REST and MCP", async () => {
  const refused = await postJson("/v1/tenants", { name: "Acme" });
  assert.equal(refused.status, 401);
  assert.equal(ProblemSchema.parse(await refused.json()).code, "SignedOut");

  const signedUp = await postJson("/v1/tenants", { name: "Acme" }, browser());
  assert.equal(signedUp.status, 200);
  const owner = WhoamiSchema.parse(await signedUp.json());
  assert.equal(owner.principal.email, EMAIL);
  assert.equal(owner.principal.role, "Owner");

  const again = WhoamiSchema.parse(await (await postJson("/v1/tenants", { name: "Other" }, browser())).json());
  assert.equal(again.principal.principalId, owner.principal.principalId);
  assert.equal(again.tenant.tenantId, owner.tenant.tenantId);

  const started = DeviceAuthorizationSchema.parse(
    await (await postJson("/v1/device/code", { device_name: "e2e laptop" })).json(),
  );
  const slowDown = await postJson("/v1/device/token", { grant_type: DEVICE_GRANT, device_code: started.device_code });
  assert.equal(await oauthErrorOf(slowDown), "slow_down");

  const confirm = await call(`/device?code=${started.user_code}`, { headers: browser() });
  assert.equal(confirm.status, 200);
  const confirmHtml = await confirm.text();
  assert.match(confirmHtml, /e2e laptop/);
  assert.match(confirmHtml, /value="deny"/);

  const intruder = DeviceAuthorizationSchema.parse(
    await (await postJson("/v1/device/code", { device_name: "intruder" })).json(),
  );
  const denied = await postJson("/v1/device/deny", { userCode: intruder.user_code }, browser());
  assert.equal(denied.status, 204);
  const refusedIntruder = await postJson("/v1/device/token", {
    grant_type: DEVICE_GRANT,
    device_code: intruder.device_code,
  });
  assert.equal(await oauthErrorOf(refusedIntruder), "invalid_grant");
  const approveDenied = await postJson(
    "/v1/device/approve",
    { userCode: intruder.user_code, tenantId: owner.tenant.tenantId },
    browser(),
  );
  assert.equal(approveDenied.status, 404);

  const strangeTenant = await postJson(
    "/v1/device/approve",
    { userCode: started.user_code, tenantId: "someone-elses-tenant" },
    browser(),
  );
  assert.equal(strangeTenant.status, 403);
  assert.equal(ProblemSchema.parse(await strangeTenant.json()).title, "Not your tenant");
  const approved = await postJson(
    "/v1/device/approve",
    { userCode: started.user_code, tenantId: owner.tenant.tenantId },
    browser(),
  );
  assert.equal(approved.status, 200);
  const device = DeviceSchema.parse(await approved.json());
  assert.equal(device.principalId, owner.principal.principalId);

  await new Promise((resolve) => setTimeout(resolve, (started.interval + 5) * 1000 + 100));
  const granted = await postJson("/v1/device/token", { grant_type: DEVICE_GRANT, device_code: started.device_code });
  assert.equal(granted.status, 200);
  const deviceToken = DeviceTokenSchema.parse(await granted.json());

  const restWhoami = await call("/v1/whoami", { headers: { authorization: `Bearer ${deviceToken.access_token}` } });
  assert.equal(restWhoami.status, 200);
  const overRest = WhoamiSchema.parse(await restWhoami.json());
  assert.deepEqual(overRest, owner);

  const signedOut = await call("/v1/whoami", { headers: { authorization: `Bearer ${"x".repeat(43)}` } });
  assert.equal(signedOut.status, 401);
  assert.equal(ProblemSchema.parse(await signedOut.json()).code, "SignedOut");

  const bearer = { authorization: `Bearer ${deviceToken.access_token}` };
  const devices = await call("/v1/devices", { headers: bearer });
  assert.equal(devices.status, 200);
  assert.deepEqual(
    DeviceSchema.array()
      .parse(await devices.json())
      .map((listed) => [listed.deviceId, listed.name]),
    [[device.deviceId, "e2e laptop"]],
  );
  const listedPersonas = await call("/v1/personas", { headers: bearer });
  assert.equal(listedPersonas.status, 200);
  const personas = PersonaSchema.array().parse(await listedPersonas.json());
  assert.deepEqual(
    personas.map((persona) => [persona.tenantId, persona.name]),
    [[owner.tenant.tenantId, "Default"]],
  );
  const [defaultPersona] = personas;
  const fetchedPersona = await call(`/v1/personas/${defaultPersona?.personaId}`, { headers: bearer });
  assert.equal(fetchedPersona.status, 200);
  assert.deepEqual(PersonaSchema.parse(await fetchedPersona.json()), defaultPersona);
  const unknownPersona = await call("/v1/personas/no-such-persona", { headers: bearer });
  assert.equal(unknownPersona.status, 404);

  const unknownRevoke = await call("/v1/devices/no-such-device", { method: "DELETE", headers: bearer });
  assert.equal(unknownRevoke.status, 404);

  const registered = await postJson("/oauth/register", { redirect_uris: [CALLBACK], client_name: "e2e client" });
  assert.equal(registered.status, 201);
  const client = OAuthClientSchema.parse(await registered.json());

  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    state: "e2e-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const toConsent = await call(`/oauth/authorize?${authorize}`);
  assert.equal(toConsent.status, 303);
  const consentUrl = new URL(toConsent.headers.get("location") ?? "");
  const requestId = consentUrl.searchParams.get("request") ?? "";

  const csrf = base64Url(randomBytes(32));
  const consented = await call(`${consentUrl.pathname}`, {
    method: "POST",
    headers: {
      ...browser(),
      "content-type": "application/x-www-form-urlencoded",
      cookie: `__Host-tumpel_connect=${csrf}`,
    },
    body: new URLSearchParams({
      request: requestId,
      csrf,
      tenant: owner.tenant.tenantId,
      action: "approve",
    }).toString(),
  });
  assert.equal(consented.status, 303);
  const callback = new URL(consented.headers.get("location") ?? "");
  assert.equal(callback.searchParams.get("state"), "e2e-state");

  const redemption = {
    grant_type: "authorization_code",
    code: callback.searchParams.get("code") ?? "",
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: CALLBACK,
  };
  assert.equal(await oauthErrorOf(await form("/oauth/token", { client_id: client.client_id })), "invalid_request");
  assert.equal(
    await oauthErrorOf(await form("/oauth/token", { ...redemption, grant_type: "password" })),
    "unsupported_grant_type",
  );
  const unverified = { grant_type: "authorization_code", code: redemption.code, client_id: client.client_id };
  assert.equal(await oauthErrorOf(await form("/oauth/token", unverified)), "invalid_request");

  const tokenResponse = await form("/oauth/token", redemption);
  assert.equal(tokenResponse.status, 200);
  const oauthToken = OAuthTokenSchema.parse(await tokenResponse.json());

  const unauthorised = await mcp("", 1, "tools/list");
  assert.equal(unauthorised.status, 401);
  const refusal = (await unauthorised.json()) as { error: { data: unknown } };
  assert.equal(ProblemSchema.parse(refusal.error.data).code, "SignedOut");

  const initialized = await mcp(oauthToken.access_token, 1, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.status, 200);
  const listed = (await (await mcp(oauthToken.access_token, 2, "tools/list")).json()) as {
    result: { tools: { name: string }[] };
  };
  const toolNames = listed.result.tools.map((tool) => tool.name);
  for (const name of ["tumpel_whoami", "tumpel_host_mint_token", "tumpel_host_list", "tumpel_host_revoke"]) {
    assert.ok(toolNames.includes(name), name);
  }
  const called = (await (
    await mcp(oauthToken.access_token, 3, "tools/call", { name: "tumpel_whoami", arguments: {} })
  ).json()) as { result: { content: { text: string }[] } };
  const overMcp = WhoamiSchema.parse(JSON.parse(called.result.content[0]?.text ?? ""));
  assert.deepEqual(overMcp, overRest);

  const initializedByDevice = await mcp(deviceToken.access_token, 4, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initializedByDevice.status, 200);

  assert.equal(await oauthErrorOf(await form("/oauth/token", redemption)), "invalid_grant");
  const afterReuse = await mcp(oauthToken.access_token, 5, "tools/list");
  assert.equal(afterReuse.status, 401);

  const revoked = await call(`/v1/devices/${device.deviceId}`, { method: "DELETE", headers: bearer });
  assert.equal(revoked.status, 204);
  const afterRevoke = await call("/v1/whoami", { headers: bearer });
  assert.equal(afterRevoke.status, 401);
  assert.equal(ProblemSchema.parse(await afterRevoke.json()).code, "SignedOut");
});

test("sign-up refuses an identity assertion that is forged, meant for another audience or expired", async () => {
  const { privateKey: forger } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const cases: [string, string, RegExp][] = [
    ["forged signature", assertion(EMAIL, {}, forger), /signature does not verify/],
    ["wrong audience", assertion(EMAIL, { aud: ["another-app"] }), /another Access application/],
    ["expired", assertion(EMAIL, { iat: now - 1200, nbf: now - 1200, exp: now - 600 }), /has expired/],
  ];
  for (const [name, signed, reason] of cases) {
    const refused = await postJson("/v1/tenants", { name: "Acme" }, { "cf-access-jwt-assertion": signed, origin });
    assert.equal(refused.status, 401, name);
    const problem = ProblemSchema.parse(await refused.json());
    assert.equal(problem.code, "SignedOut", name);
    assert.match(problem.detail, reason, name);
  }
});
