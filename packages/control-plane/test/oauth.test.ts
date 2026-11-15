import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  OAuthClientSchema,
  OAuthErrorSchema,
  OAuthGrantSchema,
  OAuthTokenSchema,
  ProblemSchema,
  ProtectedResourceMetadataSchema,
  WhoamiSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import type { z } from "zod";

const AUDIENCE = "tumpel-oauth";
const KID = "oauth-key";
const PROOF_COMMON_NAME = "0123456789abcdef.access";
const OTHER_COMMON_NAME = "fedcba9876543210.access";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CSRF_COOKIE = "__Host-tumpel_connect";
const DASHBOARD = "https://app.tumpel.test";
const DASHBOARD_CALLBACK = `${DASHBOARD}/auth/callback`;
const DASHBOARD_CLIENT = "tumpel-dashboard";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;

type Database = { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };
type HarnessInit = NonNullable<Parameters<TestHarness["fetch"]>[1]>;
type HarnessResponse = Awaited<ReturnType<TestHarness["fetch"]>>;

const call = (path: string, init: HarnessInit = {}): Promise<HarnessResponse> =>
  server.fetch(path.startsWith("http") ? path : `${origin}${path}`, { redirect: "manual", ...init });

const serviceToken = (commonName: string): Record<string, string> => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], common_name: commonName, iat: now, nbf: now, exp: now + 600 });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url");
  return { "cf-access-jwt-assertion": `${header}.${payload}.${signature}` };
};

const person = (email: string): Record<string, string> => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], email, iat: now, nbf: now, exp: now + 600 });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url");
  return { "cf-access-jwt-assertion": `${header}.${payload}.${signature}` };
};

const register = (body: unknown): Promise<HarnessResponse> =>
  call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const token = (params: Record<string, string>): Promise<HarnessResponse> =>
  call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });

const oauthErrorOf = async (response: HarnessResponse): Promise<string> => {
  assert.equal(response.status, 400);
  return OAuthErrorSchema.parse(await response.json()).error;
};

const mcp = (accessToken: string, id: number, method: string, params: unknown = {}): Promise<HarnessResponse> =>
  call("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const consentUrl = async (clientId: string, challenge: string): Promise<URL> => {
  const ask = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: "oauth-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  const redirected = await call(`/oauth/authorize?${ask}`);
  assert.equal(redirected.status, 303);
  return new URL(redirected.headers.get("location") ?? "");
};

const consent = async (url: URL, signer: Record<string, string>): Promise<HarnessResponse> => {
  const page = await call(url.toString(), { headers: signer });
  if (page.status !== 200) return page;
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.ok(cookie.startsWith(`${CSRF_COOKIE}=`));
  const tenant = /name="tenant" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  return call(url.pathname, {
    method: "POST",
    headers: { ...signer, origin, cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      request: url.searchParams.get("request") ?? "",
      csrf: cookie.slice(CSRF_COOKIE.length + 1),
      tenant,
      action: "approve",
    }).toString(),
  });
};

const codeFrom = (consented: HarnessResponse): string => {
  assert.equal(consented.status, 303);
  const callback = new URL(consented.headers.get("location") ?? "");
  assert.equal(`${callback.origin}${callback.pathname}`, CALLBACK);
  assert.equal(callback.searchParams.get("state"), "oauth-state");
  assert.equal(callback.searchParams.get("iss"), origin);
  return callback.searchParams.get("code") ?? "";
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
        vars: {
          ACCESS_ISSUER: issuer,
          ACCESS_AUD: AUDIENCE,
          ACCESS_PROOF_COMMON_NAME: PROOF_COMMON_NAME,
          SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
          DASHBOARD_ORIGIN: DASHBOARD,
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  await (await server.getWorker<{ DB: Database }>().getEnv()).DB.prepare(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at, first_party) VALUES (?, ?, ?, ?, 1) ON CONFLICT (client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris, first_party = 1",
  )
    .bind(DASHBOARD_CLIENT, "the tumpel dashboard", JSON.stringify([DASHBOARD_CALLBACK]), Date.now())
    .run();
});

after(async () => {
  await server?.close();
  certs?.close();
});

test("the 401 from /mcp leads through both metadata documents to S256 PKCE, public clients and registration", async () => {
  const signedOut = await call("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(signedOut.status, 401);
  const challenge = signedOut.headers.get("www-authenticate") ?? "";
  const pointer = /^Bearer resource_metadata="([^"]+)", scope="tumpel"$/.exec(challenge);
  assert.ok(pointer?.[1], challenge);

  const unknown = await mcp(randomBytes(32).toString("base64url"), 1, "tools/list");
  assert.equal(unknown.status, 401);
  assert.equal(
    unknown.headers.get("www-authenticate"),
    `Bearer error="invalid_token", resource_metadata="${pointer[1]}", scope="tumpel"`,
  );

  const resource = ProtectedResourceMetadataSchema.parse(await (await call(pointer[1])).json());
  assert.equal(resource.resource, `${origin}/mcp`);
  assert.deepEqual(resource.authorization_servers, [origin]);
  assert.deepEqual(
    ProtectedResourceMetadataSchema.parse(await (await call("/.well-known/oauth-protected-resource")).json()),
    resource,
  );
});

test("registration refuses missing and unusable redirect addresses and registers a public client", async () => {
  assert.equal(await oauthErrorOf(await register({ client_name: "no callback" })), "invalid_client_metadata");
  assert.equal(await oauthErrorOf(await register({ redirect_uris: [] })), "invalid_client_metadata");
  for (const uri of ["http://claude.ai/callback", "https://claude.ai/callback#here", "https://user:pw@claude.ai/cb"]) {
    assert.equal(await oauthErrorOf(await register({ redirect_uris: [uri] })), "invalid_redirect_uri", uri);
  }

  const registered = await register({
    redirect_uris: [CALLBACK],
    client_name: "Claude",
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
  });
  assert.equal(registered.status, 201);
  const client = OAuthClientSchema.parse(await registered.json());
  assert.deepEqual(client.redirect_uris, [CALLBACK]);
  assert.equal(client.client_name, "Claude");
  assert.equal(client.token_endpoint_auth_method, "none");
});

test("the proof's service token consents, PKCE refuses a wrong verifier, and the token reaches /mcp as the proof tenant", async () => {
  const client = OAuthClientSchema.parse(await (await register({ redirect_uris: [CALLBACK] })).json());

  const stranger = await consent(await consentUrl(client.client_id, pkce().challenge), serviceToken(OTHER_COMMON_NAME));
  assert.equal(stranger.status, 403);
  assert.equal(ProblemSchema.parse(await stranger.json()).title, "Unknown service token");

  const proof = serviceToken(PROOF_COMMON_NAME);
  const wrong = pkce();
  const wrongCode = codeFrom(await consent(await consentUrl(client.client_id, wrong.challenge), proof));
  const mismatch = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code: wrongCode,
    code_verifier: pkce().verifier,
    redirect_uri: CALLBACK,
  });
  assert.equal(await oauthErrorOf(mismatch), "invalid_grant");

  const right = pkce();
  const code = codeFrom(await consent(await consentUrl(client.client_id, right.challenge), proof));
  const redemption = {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    code_verifier: right.verifier,
    redirect_uri: CALLBACK,
    resource: `${origin}/mcp`,
  };
  const issued = await token(redemption);
  assert.equal(issued.status, 200);
  const first = OAuthTokenSchema.parse(await issued.json());

  const refreshed = await token({
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: first.refresh_token,
  });
  assert.equal(refreshed.status, 200);
  const second = OAuthTokenSchema.parse(await refreshed.json());

  for (const accessToken of [first.access_token, second.access_token]) {
    const answered = (await (
      await mcp(accessToken, 2, "tools/call", { name: "tumpel_whoami", arguments: {} })
    ).json()) as { result: { content: { text: string }[] } };
    const whoami = WhoamiSchema.parse(JSON.parse(answered.result.content[0]?.text ?? ""));
    assert.equal(whoami.tenant.name, "Tumpel proof");
  }

  const replay = await token({
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: first.refresh_token,
  });
  assert.equal(await oauthErrorOf(replay), "invalid_grant");
  assert.equal((await mcp(second.access_token, 6, "tools/list")).status, 401);
  assert.equal(
    await oauthErrorOf(
      await token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: second.refresh_token }),
    ),
    "invalid_grant",
  );
});

test("redeeming a spent authorization code again revokes the tokens it issued", async () => {
  const client = OAuthClientSchema.parse(await (await register({ redirect_uris: [CALLBACK] })).json());
  const pair = pkce();
  const code = codeFrom(
    await consent(await consentUrl(client.client_id, pair.challenge), serviceToken(PROOF_COMMON_NAME)),
  );
  const redemption = {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    code_verifier: pair.verifier,
    redirect_uri: CALLBACK,
  };
  const issued = OAuthTokenSchema.parse(await (await token(redemption)).json());
  assert.equal((await mcp(issued.access_token, 1, "tools/list")).status, 200);
  assert.equal(await oauthErrorOf(await token(redemption)), "invalid_grant");
  assert.equal((await mcp(issued.access_token, 2, "tools/list")).status, 401);
});

const dashboardConsent = async (challenge: string): Promise<URL> => {
  const ask = new URLSearchParams({
    response_type: "code",
    client_id: DASHBOARD_CLIENT,
    redirect_uri: DASHBOARD_CALLBACK,
    state: "dashboard-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const redirected = await call(`/oauth/authorize?${ask}`);
  assert.equal(redirected.status, 303);
  const consentAt = new URL(redirected.headers.get("location") ?? "");
  assert.equal(consentAt.pathname, "/oauth/consent");
  return consentAt;
};

const dashboardToken = async (
  granted: HarnessResponse,
  verifier: string,
): Promise<z.infer<typeof OAuthTokenSchema>> => {
  assert.equal(granted.status, 303);
  const callback = new URL(granted.headers.get("location") ?? "");
  assert.equal(`${callback.origin}${callback.pathname}`, DASHBOARD_CALLBACK);
  assert.equal(callback.searchParams.get("state"), "dashboard-state");

  const issued = await token({
    grant_type: "authorization_code",
    client_id: DASHBOARD_CLIENT,
    code: callback.searchParams.get("code") ?? "",
    code_verifier: verifier,
    redirect_uri: DASHBOARD_CALLBACK,
  });
  assert.equal(issued.status, 200);
  return OAuthTokenSchema.parse(await issued.json());
};

const dashboardSignIn = async (): Promise<z.infer<typeof OAuthTokenSchema>> => {
  const pair = pkce();
  const consentAt = await dashboardConsent(pair.challenge);
  assert.equal((await call(consentAt.toString())).status, 401);
  return dashboardToken(await call(consentAt.toString(), { headers: serviceToken(PROOF_COMMON_NAME) }), pair.verifier);
};

test("an Access email with no tenant signs up on the dashboard's consent page and finishes the same sign-in", async () => {
  const email = "first-run@example.test";
  const pair = pkce();
  const consentAt = await dashboardConsent(pair.challenge);
  const form = await call(consentAt.toString(), { headers: person(email) });
  assert.equal(form.status, 200);
  assert.match(await form.text(), /Create your tenant/);

  const created = await call("/v1/tenants", {
    method: "POST",
    headers: { ...person(email), origin, "content-type": "application/json" },
    body: JSON.stringify({ name: "First run", gitAuthorName: "First Run", gitAuthorEmail: "first-run@example.test" }),
  });
  assert.equal(created.status, 200);

  const signedIn = await dashboardToken(await call(consentAt.toString(), { headers: person(email) }), pair.verifier);
  const bearer = { authorization: `Bearer ${signedIn.access_token}` };
  const whoami = WhoamiSchema.parse(await (await call("/v1/whoami", { headers: bearer })).json());
  assert.deepEqual([whoami.tenant.name, whoami.principal.email, whoami.principal.role], ["First run", email, "Owner"]);

  const grants = OAuthGrantSchema.array().parse(await (await call("/v1/oauth-grants", { headers: bearer })).json());
  assert.deepEqual(
    grants.map((grant) => [grant.clientId, grant.redirectOrigin]),
    [[DASHBOARD_CLIENT, DASHBOARD]],
  );
});

test("a connector's consent for an Access email with no tenant still refuses: sign-up is the dashboard's step", async () => {
  const client = OAuthClientSchema.parse(await (await register({ redirect_uris: [CALLBACK] })).json());
  const refused = await call((await consentUrl(client.client_id, pkce().challenge)).toString(), {
    headers: person("no-tenant@example.test"),
  });
  assert.equal(refused.status, 403);
  assert.equal(ProblemSchema.parse(await refused.json()).title, "No tenant");
});

test("the dashboard client skips the approval step but not Access, and its access token reaches a REST route", async () => {
  const signedIn = await dashboardSignIn();
  const whoami = await call("/v1/whoami", {
    headers: { authorization: `Bearer ${signedIn.access_token}`, origin: DASHBOARD },
  });
  assert.equal(whoami.status, 200);
  assert.equal(whoami.headers.get("access-control-allow-origin"), DASHBOARD);
  assert.equal(WhoamiSchema.parse(await whoami.json()).tenant.name, "Tumpel proof");
});

test("signing out of the dashboard on one device revokes that sign-in and keeps the other", async () => {
  const laptop = await dashboardSignIn();
  const phone = await dashboardSignIn();
  const refreshed = await token({
    grant_type: "refresh_token",
    client_id: DASHBOARD_CLIENT,
    refresh_token: laptop.refresh_token,
  });
  assert.equal(refreshed.status, 200);
  const laptopNow = OAuthTokenSchema.parse(await refreshed.json());

  const revoked = await call("/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: laptopNow.refresh_token, client_id: DASHBOARD_CLIENT }).toString(),
  });
  assert.equal(revoked.status, 200);
  const whoami = async (accessToken: string): Promise<number> =>
    (await call("/v1/whoami", { headers: { authorization: `Bearer ${accessToken}` } })).status;
  assert.deepEqual(
    [await whoami(laptop.access_token), await whoami(laptopNow.access_token), await whoami(phone.access_token)],
    [401, 401, 200],
  );
  const phoneRefreshed = await token({
    grant_type: "refresh_token",
    client_id: DASHBOARD_CLIENT,
    refresh_token: phone.refresh_token,
  });
  assert.equal(phoneRefreshed.status, 200);
});

test("an Origin outside the allow-list gets no access-control-allow-origin, the dashboard origin does", async () => {
  for (const method of ["OPTIONS", "GET"]) {
    const answered = await call("/v1/whoami", { method, headers: { origin: "https://app.elsewhere.test" } });
    assert.equal(answered.headers.get("access-control-allow-origin"), null, method);
  }
  const preflight = await call("/v1/hosts", {
    method: "OPTIONS",
    headers: { origin: DASHBOARD, "access-control-request-method": "GET" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), DASHBOARD);
});
