import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  InvitationCreatedSchema,
  InvitationSchema,
  MemberSchema,
  MembershipSchema,
  OAuthClientSchema,
  OAuthTokenSchema,
  ProblemSchema,
  WhoamiSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";

const AUDIENCE = "tumpel-members";
const KID = "members-key";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CSRF_COOKIE = "__Host-tumpel_connect";
const DASHBOARD = "https://app.tumpel.test";
const OWNER = "owner@example.test";
const BOB = "bob@example.test";
const CAROL = "carol@example.test";
const DAVE = "dave@example.test";
const IDENTITY = { gitAuthorName: "Members", gitAuthorEmail: "members@example.test" };

interface Database {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;

type HarnessInit = NonNullable<Parameters<TestHarness["fetch"]>[1]>;
type HarnessResponse = Awaited<ReturnType<TestHarness["fetch"]>>;

const call = (path: string, init: HarnessInit = {}): Promise<HarnessResponse> =>
  server.fetch(path.startsWith("http") ? path : `${origin}${path}`, { redirect: "manual", ...init });

const signedIn = (email: string): Record<string, string> => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], email, iat: now, nbf: now, exp: now + 600 });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url");
  return { "cf-access-jwt-assertion": `${header}.${payload}.${signature}`, origin };
};

const send = (
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HarnessResponse> =>
  call(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === null ? undefined : JSON.stringify(body),
  });

const signUp = async (email: string, name: string): Promise<string> => {
  const answered = await send("POST", "/v1/tenants", { name, ...IDENTITY }, signedIn(email));
  assert.equal(answered.status, 200);
  return WhoamiSchema.parse(await answered.json()).tenant.tenantId;
};

interface ConsentPage {
  url: URL;
  html: string;
  cookie: string;
  verifier: string;
  clientId: string;
}

const consentPage = async (email: string): Promise<ConsentPage> => {
  const registered = await send("POST", "/oauth/register", { redirect_uris: [CALLBACK], client_name: "members" });
  const client = OAuthClientSchema.parse(await registered.json());
  const verifier = randomBytes(32).toString("base64url");
  const ask = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const url = new URL((await call(`/oauth/authorize?${ask}`)).headers.get("location") ?? "");
  const page = await call(url.toString(), { headers: signedIn(email) });
  assert.equal(page.status, 200);
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { url, html: await page.text(), cookie, verifier, clientId: client.client_id };
};

const bearerFor = async (email: string, tenantId: string): Promise<Record<string, string>> => {
  const { url, cookie, verifier, clientId } = await consentPage(email);
  const consented = await call(url.pathname, {
    method: "POST",
    headers: { ...signedIn(email), cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      request: url.searchParams.get("request") ?? "",
      csrf: cookie.slice(CSRF_COOKIE.length + 1),
      tenant: tenantId,
      action: "approve",
    }).toString(),
  });
  assert.equal(consented.status, 303);
  const code = new URL(consented.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const redeemed = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
    }).toString(),
  });
  assert.equal(redeemed.status, 200);
  return { authorization: `Bearer ${OAuthTokenSchema.parse(await redeemed.json()).access_token}` };
};

const refusal = async (response: HarnessResponse, status: number): Promise<{ code: string; fix: string }> => {
  assert.equal(response.status, status);
  return ProblemSchema.parse(await response.json());
};

const invite = async (
  bearer: Record<string, string>,
  email: string,
  role: "Owner" | "Member",
): Promise<{ invitationId: string; token: string }> => {
  const answered = await send("POST", "/v1/invitations", { email, role }, bearer);
  assert.equal(answered.status, 200);
  const created = InvitationCreatedSchema.parse(await answered.json());
  const link = new URL(created.acceptUrl);
  assert.equal(link.pathname, "/invitations/accept");
  return { invitationId: created.invitation.invitationId, token: link.searchParams.get("token") ?? "" };
};

const accept = (email: string, token: string): Promise<HarnessResponse> =>
  send("POST", "/v1/invitations/accept", { token }, signedIn(email));

let acme: string;
let bobco: string;
let owner: Record<string, string>;
let bob: Record<string, string>;
let bobPrincipalId: string;

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
          DASHBOARD_ORIGIN: DASHBOARD,
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  acme = await signUp(OWNER, "Acme");
  bobco = await signUp(BOB, "Bobco");
  owner = await bearerFor(OWNER, acme);
});

after(async () => {
  await server?.close();
  certs?.close();
});

test("an invitation binds to its email exactly, is spent once, and the invitee then lists both tenants", async () => {
  const { token } = await invite(owner, "Bob@Example.test", "Member");

  const otherPage = await call(`/invitations/accept?token=${encodeURIComponent(token)}`, { headers: signedIn(CAROL) });
  assert.equal(otherPage.status, 403);
  assert.equal((await refusal(await accept(CAROL, token), 403)).code, "Forbidden");
  assert.equal((await refusal(await accept("bob@example.test.evil", token), 403)).code, "Forbidden");
  const open = InvitationSchema.array().parse(await (await call("/v1/invitations", { headers: owner })).json());
  assert.deepEqual(
    open.map((each) => [each.email, each.role]),
    [[BOB, "Member"]],
  );

  const page = await call(`/invitations/accept?token=${encodeURIComponent(token)}`, { headers: signedIn(BOB) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Join Acme/);

  const accepted = await accept(BOB, token);
  assert.equal(accepted.status, 200);
  const joined = WhoamiSchema.parse(await accepted.json());
  assert.deepEqual([joined.tenant.tenantId, joined.principal.role], [acme, "Member"]);
  bobPrincipalId = joined.principal.principalId;
  assert.match((await refusal(await accept(BOB, token), 404)).fix, /Ask an Owner/);

  const { html } = await consentPage(BOB);
  assert.deepEqual(
    [...html.matchAll(/<option value="([^"]+)">/g)].map((option) => option[1]),
    [bobco, acme],
  );
  bob = await bearerFor(BOB, acme);
  const tenants = MembershipSchema.array().parse(await (await call("/v1/whoami/tenants", { headers: bob })).json());
  assert.deepEqual(
    tenants.map((membership) => [membership.tenant.name, membership.role]),
    [
      ["Bobco", "Owner"],
      ["Acme", "Member"],
    ],
  );
  const whoami = WhoamiSchema.parse(await (await call("/v1/whoami", { headers: bob })).json());
  assert.deepEqual([whoami.tenant.tenantId, whoami.principal.role], [acme, "Member"]);
  const members = MemberSchema.array().parse(await (await call("/v1/members", { headers: bob })).json());
  assert.deepEqual(
    members.map((member) => [member.email, member.role]),
    [
      [OWNER, "Owner"],
      [BOB, "Member"],
    ],
  );
  assert.deepEqual(
    InvitationSchema.array().parse(await (await call("/v1/invitations", { headers: owner })).json()),
    [],
  );
});

test("a Member is refused the member and connection operations of an Owner", async () => {
  const ownerId = WhoamiSchema.parse(await (await call("/v1/whoami", { headers: owner })).json()).principal.principalId;
  const refusals = [
    await send("POST", "/v1/invitations", { email: DAVE, role: "Member" }, bob),
    await send("DELETE", `/v1/members/${ownerId}`, null, bob),
    await send("POST", "/v1/namespace-connection/start", { accountLabel: "ns", audience: "aud" }, bob),
    await send("DELETE", "/v1/github-actions-connection", null, bob),
    await send("POST", "/v1/github-connection/start", null, bob),
  ];
  for (const refused of refusals) assert.equal((await refusal(refused, 403)).code, "OwnerRequired");
  assert.equal((await call("/v1/connections", { headers: bob })).status, 200);
});

test("the last Owner stays, and a removed member's token answers 401", async () => {
  const ownerId = WhoamiSchema.parse(await (await call("/v1/whoami", { headers: owner })).json()).principal.principalId;
  const lastOwner = await refusal(await send("DELETE", `/v1/members/${ownerId}`, null, owner), 409);
  assert.equal(lastOwner.code, "LastOwner");

  assert.equal((await send("DELETE", `/v1/members/${bobPrincipalId}`, null, owner)).status, 204);
  assert.equal((await refusal(await call("/v1/whoami", { headers: bob }), 401)).code, "SignedOut");
  const tenants = MembershipSchema.array().parse(
    await (await call("/v1/whoami/tenants", { headers: await bearerFor(BOB, bobco) })).json(),
  );
  assert.deepEqual(
    tenants.map((membership) => membership.tenant.tenantId),
    [bobco],
  );
});

test("an expired, revoked or forged invitation is refused", async () => {
  const expiring = await invite(owner, DAVE, "Owner");
  const env = await server.getWorker<{ DB: Database }>().getEnv();
  await env.DB.prepare("UPDATE invitations SET expires_at = ? WHERE invitation_id = ?")
    .bind(Date.now() - 1, expiring.invitationId)
    .run();
  assert.equal((await refusal(await accept(DAVE, expiring.token), 410)).code, "InvitationExpired");

  const revoked = await invite(owner, DAVE, "Owner");
  assert.equal((await send("DELETE", `/v1/invitations/${revoked.invitationId}`, null, owner)).status, 204);
  assert.equal((await refusal(await accept(DAVE, revoked.token), 404)).code, "NotFound");

  const genuine = await invite(owner, DAVE, "Owner");
  const forged = `${genuine.invitationId}.${randomBytes(32).toString("base64url")}`;
  assert.equal((await refusal(await accept(DAVE, forged), 404)).code, "NotFound");
  const joined = WhoamiSchema.parse(await (await accept(DAVE, genuine.token)).json());
  assert.deepEqual([joined.tenant.tenantId, joined.principal.role], [acme, "Owner"]);
});
