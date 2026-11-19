import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  GitHubInstallationSchema,
  GitHubInstallStartSchema,
  GitHubIssueSchema,
  GitHubRepositorySchema,
  OAuthClientSchema,
  OAuthTokenSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { deriveSigningKey } from "../src/envelope.ts";
import {
  appManifest,
  botLogin,
  botUserId,
  CONTENTS_READ,
  commitIdentity,
  convertManifest,
  dashboardReturn,
  type Fetch,
  githubRepository,
  grantedNeeds,
  importAppKey,
  installedBy,
  listInstallationRepositories,
  listOpenIssues,
  mintInstallationToken,
  mintInstallationWideToken,
  mintOwnerTokens,
  pkcs8FromPem,
  readState,
  repositoryCredential,
  signState,
  tokenUser,
  uncovered,
  verifyInstaller,
  verifyWebhookSignature,
  withOwnerTokens,
  withRepositoryToken,
} from "../src/github.ts";
import { GitHubInstallStateSchema, GitHubManifestStateSchema } from "../src/github-schemas.ts";
import { TEST_SETTINGS } from "./timing.ts";

type Call = { url: string; init: RequestInit };

const spiedFetch = (status: number, body: unknown): { fetcher: Fetch; calls: Call[] } => answering([[status, body]]);

const answering = (answers: [number, unknown][]): { fetcher: Fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const fetcher: Fetch = async (url, init) => {
    const [status, body] = answers[calls.length] ?? [500, { message: "unexpected call" }];
    calls.push({ url, init });
    return Response.json(body, { status });
  };
  return { fetcher, calls };
};

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1Pem = keyPair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8Pem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = crypto.subtle.importKey(
  "spki",
  keyPair.publicKey.export({ type: "spki", format: "der" }),
  { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  false,
  ["verify"],
);

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(text, "base64url"));

const header = (init: RequestInit, name: string): string | null => new Headers(init.headers).get(name);

test("the manifest conversion posts the code to GitHub without a credential and reads the App it answers", async () => {
  const conversion = {
    id: 42,
    slug: "tumpel-dev",
    client_id: "Iv23client",
    client_secret: "client-secret",
    webhook_secret: "webhook-secret",
    pem: pkcs1Pem,
    owner: { login: "octo" },
    html_url: "https://github.com/apps/tumpel-dev",
    node_id: "ignored",
  };
  const { fetcher, calls } = spiedFetch(201, conversion);
  const answer = await convertManifest(fetcher, "https://api.github.com", "code/1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.github.com/app-manifests/code%2F1/conversions");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(header(calls[0]?.init ?? {}, "authorization"), null);
  assert.ok(answer.ok);
  assert.equal(answer.value.id, 42);
  assert.equal(answer.value.owner.login, "octo");

  const refused = await convertManifest(
    spiedFetch(404, { message: "Not Found" }).fetcher,
    "https://api.github.com",
    "spent",
  );
  assert.ok(!refused.ok);
  assert.match(refused.detail, /404: Not Found/);
});

test("the manifest returns installs and deliveries to the control plane and asks for no organization-wide admin permission", () => {
  const manifest = appManifest("https://api.dev.tumpel.dev");
  assert.equal(manifest.setup_url, "https://api.dev.tumpel.dev/github/app/installed");
  assert.deepEqual(manifest.callback_urls, [manifest.setup_url]);
  assert.equal(manifest.request_oauth_on_install, true);
  assert.equal(manifest.setup_on_update, true);
  assert.equal(manifest.redirect_url, "https://api.dev.tumpel.dev/github/app/created");
  assert.equal(manifest.public, true);
  assert.equal(manifest.hook_attributes.url, "https://api.dev.tumpel.dev/github/webhook");
  assert.ok(manifest.name.length <= 34);
  assert.notEqual(manifest.name, appManifest("https://api.tumpel.dev").name);
  assert.equal(manifest.default_permissions.members, "read");
  assert.equal(manifest.default_permissions.administration, "write");
  for (const permission of ["organization_administration", "organization_secrets", "repository_creation"]) {
    assert.ok(!(permission in manifest.default_permissions), permission);
  }
});

test("GitHub's PKCS#1 private key and a PKCS#8 one import as the same signing key", async () => {
  const fromPkcs1 = pkcs8FromPem(pkcs1Pem);
  assert.deepEqual(fromPkcs1, pkcs8FromPem(pkcs8Pem));
  await importAppKey(fromPkcs1);
  assert.throws(() => pkcs8FromPem("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"), /PKCS#1 or PKCS#8/);
});

test("a signed state reads back until it expires, and not when tampered with or signed for another step", async () => {
  const key = await deriveSigningKey(Buffer.alloc(32, 7).toString("base64"), "tumpel-github-state-v1");
  const now = Date.parse("2026-11-15T10:00:00Z");
  const claims = {
    purpose: "Installation" as const,
    tenantId: "tenant-1",
    email: "owner@example.test",
    expiresAt: "2026-11-15T11:00:00.000Z",
  };
  const state = await signState(key, claims);

  const read = await readState(key, state, GitHubInstallStateSchema, now);
  assert.deepEqual(read, { ok: true, claims });

  const expired = await readState(key, state, GitHubInstallStateSchema, Date.parse("2026-11-15T11:00:00Z"));
  assert.ok(!expired.ok && /expired/.test(expired.reason));

  const [body, signature] = state.split(".");
  const forged = Buffer.from(JSON.stringify({ ...claims, tenantId: "tenant-2" })).toString("base64url");
  assert.ok(!(await readState(key, `${forged}.${signature}`, GitHubInstallStateSchema, now)).ok);
  assert.ok(!(await readState(key, `${body}.${signature}.x`, GitHubInstallStateSchema, now)).ok);

  const otherKey = await deriveSigningKey(Buffer.alloc(32, 8).toString("base64"), "tumpel-github-state-v1");
  assert.ok(!(await readState(otherKey, state, GitHubInstallStateSchema, now)).ok);

  const wrongStep = await readState(key, state, GitHubManifestStateSchema, now);
  assert.ok(!wrongStep.ok && /another step/.test(wrongStep.reason));
});

test("an install returns only to a page on the dashboard's origin", () => {
  const dashboard = "https://app.tumpel.test";
  assert.deepEqual(dashboardReturn(null, dashboard), { ok: true, returnUrl: undefined });
  assert.deepEqual(dashboardReturn(`${dashboard}/t/tnt_1/setup/github?from=github`, dashboard), {
    ok: true,
    returnUrl: `${dashboard}/t/tnt_1/setup/github?from=github`,
  });
  for (const elsewhere of [
    "https://evil.test/t/tnt_1/setup/github",
    "https://app.tumpel.test.evil.test/",
    "http://app.tumpel.test/t/tnt_1",
    "//evil.test/x",
    "javascript:alert(1)",
  ]) {
    assert.equal(dashboardReturn(elsewhere, dashboard).ok, false, elsewhere);
  }
  assert.equal(dashboardReturn(`${dashboard}/t`, "").ok, false);
});

test("a webhook signature matches GitHub's documented example and nothing else", async () => {
  const secret = "It's a Secret to Everybody";
  const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;
  assert.ok(await verifyWebhookSignature(secret, bytes("Hello, World!"), signature));
  assert.ok(!(await verifyWebhookSignature(secret, bytes("Hello, World?"), signature)));
  assert.ok(!(await verifyWebhookSignature("another secret", bytes("Hello, World!"), signature)));
  assert.ok(!(await verifyWebhookSignature(secret, bytes("Hello, World!"), null)));
  assert.ok(!(await verifyWebhookSignature(secret, bytes("Hello, World!"), signature.replace("sha256=", "sha1="))));
});

test("an installation token is minted for the session's repository, by the installation on its owner, with a JWT the App's key signs", async () => {
  const now = Date.parse("2026-11-15T10:00:00Z");
  const app = { clientId: "Iv23client", privateKey: await importAppKey(pkcs8FromPem(pkcs1Pem)) };
  const installation = { installationId: 7, accountLogin: "Octo", status: "Active" as const };
  const { fetcher, calls } = spiedFetch(201, {
    token: "ghs_minted",
    expires_at: "2026-11-15T11:00:00Z",
    permissions: { contents: "write" },
  });

  const minted = await mintInstallationToken(
    fetcher,
    "https://api.github.com",
    app,
    installation,
    { owner: "octo", name: "widgets" },
    now,
    { kind: "Exact", permissions: { contents: "read" } },
  );
  assert.deepEqual(minted, {
    kind: "Minted",
    token: "ghs_minted",
    expiresAt: "2026-11-15T11:00:00Z",
    permissions: { contents: "write" },
  });
  assert.equal(calls[0]?.url, "https://api.github.com/app/installations/7/access_tokens");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    repositories: ["widgets"],
    permissions: { contents: "read" },
  });

  const jwt = (header(calls[0]?.init ?? {}, "authorization") ?? "").replace(/^Bearer /, "");
  const [head, payload, signature] = jwt.split(".");
  assert.ok(head !== undefined && payload !== undefined && signature !== undefined);
  assert.ok(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      await publicKey,
      fromBase64Url(signature),
      new TextEncoder().encode(`${head}.${payload}`),
    ),
  );
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.iss, "Iv23client");
  assert.equal(claims.iat, now / 1000 - 60);
  assert.ok(claims.exp - claims.iat <= 600);
});

test("a repository outside the installation names the fix, and only a 404 or 422 says to add it", async () => {
  const now = Date.parse("2026-11-15T10:00:00Z");
  const app = { clientId: "Iv23client", privateKey: await importAppKey(pkcs8FromPem(pkcs8Pem)) };
  const installation = { installationId: 7, accountLogin: "octo", status: "Active" as const };

  const notCovered = await mintInstallationToken(
    spiedFetch(422, { message: "There is at least one repository that does not exist or is not accessible" }).fetcher,
    "https://api.github.com",
    app,
    installation,
    { owner: "octo", name: "private" },
    now,
    CONTENTS_READ,
  );
  assert.equal(notCovered.kind, "Outside");
  assert.match(notCovered.kind === "Outside" ? notCovered.detail : "", /422: There is at least one repository/);
  assert.match(notCovered.kind === "Outside" ? notCovered.detail : "", /github\.com\/settings\/installations\/7/);

  const down = await mintInstallationToken(
    spiedFetch(503, { message: "Service Unavailable" }).fetcher,
    "https://api.github.com",
    app,
    installation,
    { owner: "octo", name: "private" },
    now,
    CONTENTS_READ,
  );
  assert.equal(down.kind, "Refused");
  assert.doesNotMatch(down.kind === "Refused" ? down.detail : "", /add octo\/private/);

  const foreign = uncovered(["octo"], { owner: "acme", name: "x" });
  assert.match(foreign.kind === "Outside" ? foreign.detail : "", /cover repositories of octo only/);
  assert.deepEqual(uncovered([], { owner: "octo", name: "x" }), { kind: "NoToken" });

  const elsewhere = spiedFetch(201, {});
  const suspended = await mintInstallationToken(
    elsewhere.fetcher,
    "https://api.github.com",
    app,
    { ...installation, status: "Suspended" },
    { owner: "octo", name: "x" },
    now,
    CONTENTS_READ,
  );
  assert.match(suspended.kind === "Outside" ? suspended.detail : "", /suspended/);
  assert.equal(elsewhere.calls.length, 0);
});

test("a turn gets a token for every active installation, scoped to what the installation grants, routed by owner", async () => {
  const now = Date.parse("2026-11-15T10:00:00Z");
  const app = { clientId: "Iv23client", privateKey: await importAppKey(pkcs8FromPem(pkcs8Pem)) };
  const calls: Call[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "GET") {
      return Response.json({ permissions: { contents: "write", issues: "read", metadata: "read" } }, { status: 200 });
    }
    const token = url.endsWith("/installations/7/access_tokens") ? "ghs_mine" : "ghs_org";
    return Response.json({ token, expires_at: "2026-11-15T11:00:00Z", permissions: {} }, { status: 201 });
  };

  const minted = await mintOwnerTokens(
    fetcher,
    "https://api.github.com",
    app,
    [
      { installationId: 7, accountLogin: "mvhenten", status: "Active" },
      { installationId: 8, accountLogin: "Tumpel", status: "Active" },
      { installationId: 9, accountLogin: "paused", status: "Suspended" },
    ],
    { owner: "Tumpel", name: "protocol" },
    now,
  );
  const granted = JSON.stringify({ permissions: { contents: "write", issues: "read", metadata: "read" } });
  assert.deepEqual(calls.map(({ url, init }) => [url, init.body ?? null]).sort(), [
    ["https://api.github.com/app/installations/7", null],
    ["https://api.github.com/app/installations/7/access_tokens", granted],
    ["https://api.github.com/app/installations/8", null],
    ["https://api.github.com/app/installations/8/access_tokens", granted],
  ]);
  assert.ok(minted.ok);
  assert.deepEqual(
    withOwnerTokens(
      [
        { name: "ANTHROPIC_API_KEY", value: "sk-ant" },
        { name: "GITHUB_TOKEN", value: "ghs_scoped" },
      ],
      minted.value,
      { owner: "Tumpel", name: "protocol" },
    ),
    [
      { name: "ANTHROPIC_API_KEY", value: "sk-ant" },
      { name: "GITHUB_TOKEN", value: "ghs_org" },
      { name: "GH_TOKEN", value: "ghs_org" },
      { name: "TUMPEL_GITHUB_TOKENS", value: "mvhenten=ghs_mine tumpel=ghs_org" },
    ],
  );
});

test("an installation that fails to mint leaves the turn the other owners, unless it is the session owner", async () => {
  const now = Date.parse("2026-11-15T10:00:00Z");
  const app = { clientId: "Iv23client", privateKey: await importAppKey(pkcs8FromPem(pkcs8Pem)) };
  const fetcher: Fetch = async (url) =>
    url.endsWith("/installations/8/access_tokens")
      ? Response.json({ message: "Bad credentials" }, { status: 401 })
      : Response.json(
          { token: `ghs_${url.split("/")[5]}`, expires_at: "2026-11-15T11:00:00Z", permissions: {} },
          { status: 201 },
        );
  const installations = [
    { installationId: 7, accountLogin: "mvhenten", status: "Active" as const },
    { installationId: 8, accountLogin: "broken", status: "Active" as const },
    { installationId: 9, accountLogin: "tumpel", status: "Active" as const },
  ];

  const minted = await mintOwnerTokens(
    fetcher,
    "https://api.github.com",
    app,
    installations,
    { owner: "mvhenten", name: "tumpel" },
    now,
  );
  assert.deepEqual(minted, {
    ok: true,
    value: [
      { owner: "mvhenten", token: "ghs_7" },
      { owner: "tumpel", token: "ghs_9" },
    ],
  });

  const own = await mintOwnerTokens(
    fetcher,
    "https://api.github.com",
    app,
    installations,
    { owner: "broken", name: "x" },
    now,
  );
  assert.ok(!own.ok);
  assert.match(own.detail, /installation token for broken/);
});

test("a repository outside the installation uses the secret set's GITHUB_TOKEN, and is refused without one", () => {
  const provider = { name: "ANTHROPIC_API_KEY", value: "sk-ant" };
  const fromSet = { name: "GITHUB_TOKEN", value: "ghp_set" };
  const outside = { kind: "Outside" as const, detail: "acme/x is outside the installation" };

  assert.deepEqual(repositoryCredential([provider, fromSet], outside), {
    kind: "Ready",
    variables: [provider, fromSet],
    source: "SecretSet",
  });
  assert.deepEqual(repositoryCredential([provider], outside), { kind: "Refused", detail: outside.detail });
  assert.deepEqual(repositoryCredential([provider, fromSet], { kind: "Refused", detail: "GitHub is down" }), {
    kind: "Refused",
    detail: "GitHub is down",
  });
});

const oauthClient = { clientId: "Iv23client", clientSecret: "client-secret" };

const origins = { api: "https://api.github.com", web: "https://github.com" };

test("an installation is accessible only when the authorized account can access it", async () => {
  const record = { id: 7, account: { id: 1, login: "octo", type: "User" } };
  const listed = { total_count: 1, installations: [record] };
  const exchanged: [number, unknown] = [200, { access_token: "ghu_user", token_type: "bearer", scope: "" }];

  const owned = answering([exchanged, [200, listed], [200, { id: 1, login: "Octo" }]]);
  assert.deepEqual(await verifyInstaller(owned.fetcher, origins, oauthClient, "code-1", 7), {
    kind: "Accessible",
    user: { githubUserId: 1, login: "Octo" },
    installation: record,
  });
  assert.equal(owned.calls[0]?.url, "https://github.com/login/oauth/access_token");
  assert.equal(header(owned.calls[0]?.init ?? {}, "accept"), "application/json");
  assert.deepEqual(JSON.parse(String(owned.calls[0]?.init.body)), {
    client_id: "Iv23client",
    client_secret: "client-secret",
    code: "code-1",
  });
  assert.equal(owned.calls[1]?.url, "https://api.github.com/user/installations?per_page=100");
  assert.equal(header(owned.calls[1]?.init ?? {}, "authorization"), "Bearer ghu_user");

  const someoneElses = answering([exchanged, [200, listed]]);
  assert.equal((await verifyInstaller(someoneElses.fetcher, origins, oauthClient, "code-1", 8)).kind, "NotInstaller");

  const spent = answering([[200, { error: "bad_verification_code", error_description: "The code is incorrect." }]]);
  const failed = await verifyInstaller(spent.fetcher, origins, oauthClient, "spent", 7);
  assert.equal(failed.kind, "Failed");
  assert.equal(spent.calls.length, 1);
});

test("a personal account links only to its own account id, and an organization only to its recorded installer", () => {
  const personal = { id: 7, account: { id: 1, login: "octo", type: "User" as const } };
  assert.deepEqual(installedBy({ githubUserId: 1, login: "Octo" }, personal, { kind: "Unrecorded" }), {
    kind: "Installer",
    installation: personal,
  });
  assert.equal(
    installedBy({ githubUserId: 2, login: "reader" }, personal, { kind: "Recorded", githubUserId: 2 }).kind,
    "NotInstaller",
  );

  const organization = { id: 9, account: { id: 900, login: "acme", type: "Organization" as const } };
  const owner = { githubUserId: 5, login: "owner" };
  assert.equal(installedBy(owner, organization, { kind: "Unrecorded" }).kind, "InstallerUnknown");
  assert.deepEqual(installedBy(owner, organization, { kind: "Recorded", githubUserId: 5 }), {
    kind: "Installer",
    installation: organization,
  });
  const mismatch = installedBy(owner, organization, { kind: "Recorded", githubUserId: 6 });
  assert.equal(mismatch.kind, "NotInstaller");
  assert.match(
    mismatch.kind === "NotInstaller" ? mismatch.detail : "",
    /owner, who did not install the App on the organization acme/,
  );
});

test("the handover names where GITHUB_TOKEN came from, and an installation token replaces the secret set's", () => {
  const provider = { name: "ANTHROPIC_API_KEY", value: "sk-ant" };
  const fromSet = { name: "GITHUB_TOKEN", value: "ghp_set" };

  assert.deepEqual(withRepositoryToken([provider], null), { variables: [provider], source: "None" });
  assert.deepEqual(withRepositoryToken([provider, fromSet], null), {
    variables: [provider, fromSet],
    source: "SecretSet",
  });
  assert.deepEqual(withRepositoryToken([provider, fromSet, { name: "GH_TOKEN", value: "ghp_gh" }], "ghs_app"), {
    variables: [provider, { name: "GITHUB_TOKEN", value: "ghs_app" }, { name: "GH_TOKEN", value: "ghs_app" }],
    source: "GitHubApp",
  });
});

const gitHubRepository = (index: number) => ({
  id: index,
  name: `repo-${index}`,
  full_name: `octo/repo-${index}`,
  owner: { login: "octo", id: 1 },
  default_branch: index % 2 === 0 ? "main" : "trunk",
  private: index % 2 === 1,
  html_url: `https://github.com/octo/repo-${index}`,
});

const gitHubIssue = (number: number, pullRequest: boolean) => ({
  number,
  title: `issue ${number}`,
  html_url: `https://github.com/octo/widgets/${pullRequest ? "pull" : "issues"}/${number}`,
  body: null,
  state: "open",
  updated_at: "2026-11-14T09:30:00Z",
  labels: [{ id: 3, name: "bug", color: "d73a4a" }],
  ...(pullRequest ? { pull_request: { url: `https://api.github.com/repos/octo/widgets/pulls/${number}` } } : {}),
});

test("a granted scope asks for each need at the level the installation holds, and drops what it lacks", () => {
  assert.deepEqual(
    grantedNeeds(
      { actions: "write", contents: "write", workflows: "write", metadata: "read" },
      { actions: "write", contents: "read", metadata: "read", issues: "write" },
    ),
    { actions: "write", contents: "read", metadata: "read" },
  );
  assert.deepEqual(grantedNeeds({ contents: "read" }, { contents: "write" }), { contents: "read" });
  assert.deepEqual(grantedNeeds({ administration: "write" }, { administration: "admin" }), { administration: "write" });
});

test("an installation-wide token is minted without naming repositories", async () => {
  const app = { clientId: "Iv23client", privateKey: await importAppKey(pkcs8FromPem(pkcs8Pem)) };
  const { fetcher, calls } = spiedFetch(201, {
    token: "ghs_wide",
    expires_at: "2026-11-15T11:00:00Z",
    permissions: {},
  });
  assert.deepEqual(
    await mintInstallationWideToken(fetcher, "https://api.github.com", app, 7, Date.parse("2026-11-15T10:00:00Z"), {
      kind: "Exact",
      permissions: { metadata: "read" },
    }),
    {
      ok: true,
      value: "ghs_wide",
    },
  );
  assert.equal(calls[0]?.url, "https://api.github.com/app/installations/7/access_tokens");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { permissions: { metadata: "read" } });
});

test("the installation's repositories are read page by page until total_count, as owner, name, default branch, visibility and URL", async () => {
  const first = Array.from({ length: 100 }, (_, index) => gitHubRepository(index + 1));
  const { fetcher, calls } = answering([
    [200, { total_count: 101, repositories: first }],
    [200, { total_count: 101, repositories: [gitHubRepository(101)] }],
  ]);
  const listed = await listInstallationRepositories(fetcher, "https://api.github.com", "ghs_wide");
  assert.ok(listed.ok);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://api.github.com/installation/repositories?per_page=100&page=1",
      "https://api.github.com/installation/repositories?per_page=100&page=2",
    ],
  );
  assert.equal(header(calls[0]?.init ?? {}, "authorization"), "Bearer ghs_wide");
  assert.equal(listed.value.length, 101);
  assert.deepEqual(GitHubRepositorySchema.parse(listed.value[100]), {
    owner: "octo",
    name: "repo-101",
    defaultBranch: "trunk",
    private: true,
    htmlUrl: "https://github.com/octo/repo-101",
  });

  const refused = await listInstallationRepositories(
    spiedFetch(401, { message: "Bad credentials" }).fetcher,
    "https://api.github.com",
    "x",
  );
  assert.ok(!refused.ok);
  assert.match(refused.detail, /GET https:\/\/api.github.com\/installation\/repositories with 401: Bad credentials/);
});

test("a repository's open issues are one page of the 100 last updated, without pull requests", async () => {
  const page = Array.from({ length: 100 }, (_, index) => gitHubIssue(index + 1, index % 10 === 0));
  const { fetcher, calls } = answering([[200, page]]);
  const listed = await listOpenIssues(fetcher, "https://api.github.com", "ghs_repo", {
    owner: "octo",
    name: "widgets",
  });
  assert.ok(listed.ok);
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://api.github.com/repos/octo/widgets/issues?state=open&sort=updated&direction=desc&per_page=100"],
  );
  assert.equal(listed.value.length, 90);
  assert.ok(listed.value.every((issue) => issue.htmlUrl.includes("/issues/")));
  assert.deepEqual(GitHubIssueSchema.parse(listed.value.at(-1)), {
    issueNumber: 100,
    title: "issue 100",
    htmlUrl: "https://github.com/octo/widgets/issues/100",
    labels: ["bug"],
    updatedAt: "2026-11-14T09:30:00Z",
  });
});

test("the box commits as the App's bot under its own user id, or as the GitHub user of the secret set's token", async () => {
  const bot = spiedFetch(200, { id: 9001, login: "tumpel-dev[bot]", type: "Bot" });
  const botId = await botUserId(bot.fetcher, "https://api.github.test", "tumpel-dev", null);
  assert.deepEqual(botId, { ok: true, value: 9001 });
  assert.equal(bot.calls[0]?.url, "https://api.github.test/users/tumpel-dev[bot]");
  assert.equal(header(bot.calls[0]?.init ?? {}, "authorization"), null);
  assert.deepEqual(commitIdentity({ githubUserId: 9001, login: botLogin("tumpel-dev") }), {
    gitAuthorName: "tumpel-dev[bot]",
    gitAuthorEmail: "9001+tumpel-dev[bot]@users.noreply.github.com",
  });

  const { fetcher, calls } = spiedFetch(200, { id: 4242, login: "octo-cat", name: "Octo" });
  const user = await tokenUser(fetcher, "https://api.github.test", "ghp_set");
  assert.deepEqual(user, { ok: true, value: { githubUserId: 4242, login: "octo-cat" } });
  assert.equal(calls[0]?.url, "https://api.github.test/user");
  assert.equal(header(calls[0]?.init ?? {}, "authorization"), "Bearer ghp_set");
  assert.deepEqual(commitIdentity({ githubUserId: 4242, login: "octo-cat" }), {
    gitAuthorName: "octo-cat",
    gitAuthorEmail: "4242+octo-cat@users.noreply.github.com",
  });

  const refused = await tokenUser(
    spiedFetch(401, { message: "Bad credentials" }).fetcher,
    "https://api.github.test",
    "ghp_stale",
  );
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.detail, /GET \S+\/user with 401: Bad credentials/);
  assert.doesNotMatch(JSON.stringify(refused), /ghp_stale/);
});

const AUDIENCE = "tumpel-github";
const KID = "github-key";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CSRF_COOKIE = "__Host-tumpel_connect";
const VICTIM = "victim@example.test";
const MALLORY = "mallory@example.test";
const ORG_INSTALLATION = { id: 88, account: { id: 500, login: "victimorg", type: "Organization" } };
const MALLORY_INSTALLATION = { id: 77, account: { id: 3, login: "mallory", type: "User" } };
const VICTIM_INSTALLATION = { id: 66, account: { id: 1, login: "victim", type: "User" } };
const RIVAL = "rival@example.test";
const RIVAL_PERSONAL = { id: 130, account: { id: 20, login: "rival", type: "User" } };
const RIVAL_ORG = { id: 131, account: { id: 702, login: "rivalorg", type: "Organization" } };
const LISTER = "lister@example.test";
const UNTYPED_INSTALLATION = { id: 140, account: { id: 30, login: "untyped", type: "User" } };
const GITHUB_PEOPLE: Record<string, { id: number; login: string; installations: unknown[] }> = {
  ghu_victim: { id: 1, login: "victim", installations: [ORG_INSTALLATION, VICTIM_INSTALLATION] },
  ghu_coowner: { id: 2, login: "coowner", installations: [ORG_INSTALLATION] },
  ghu_mallory: { id: 3, login: "mallory", installations: [MALLORY_INSTALLATION] },
  ghu_rival: { id: 20, login: "rival", installations: [RIVAL_PERSONAL, RIVAL_ORG, MALLORY_INSTALLATION] },
};

interface Database {
  prepare(query: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } };
}

type HarnessInit = NonNullable<Parameters<TestHarness["fetch"]>[1]>;
type HarnessResponse = Awaited<ReturnType<TestHarness["fetch"]>>;

let fakeGitHub: Server;
let harness: TestHarness;
let origin: string;
let issuer: string;
let victimTenant: string;
let malloryTenant: string;

const bodyOf = async (request: IncomingMessage): Promise<string> => {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
};

const answer = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const gitHubStandIn = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const path = request.url ?? "";
  if (path === "/cdn-cgi/access/certs") {
    return answer(response, 200, {
      keys: [{ ...keyPair.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256" }],
    });
  }
  if (path === "/app-manifests/conversion-code/conversions") {
    return answer(response, 201, {
      id: 42,
      slug: "tumpel-test",
      client_id: "Iv23client",
      client_secret: "client-secret",
      webhook_secret: "webhook-secret",
      pem: pkcs1Pem,
      owner: { login: "operator" },
      html_url: "https://github.com/apps/tumpel-test",
    });
  }
  if (path.startsWith("/users/")) return answer(response, 200, { id: 9001 });
  if (path === "/login/oauth/access_token") {
    const { code } = JSON.parse(await bodyOf(request));
    return answer(response, 200, { access_token: `ghu_${String(code).replace(/-code$/, "")}`, token_type: "bearer" });
  }
  if (path === `/app/installations/${UNTYPED_INSTALLATION.id}`) return answer(response, 200, UNTYPED_INSTALLATION);
  const person = GITHUB_PEOPLE[(request.headers.authorization ?? "").replace(/^Bearer /, "")];
  if (person === undefined) return answer(response, 401, { message: "Bad credentials" });
  if (path === "/user") return answer(response, 200, { id: person.id, login: person.login });
  if (path.startsWith("/user/installations")) {
    return answer(response, 200, { total_count: person.installations.length, installations: person.installations });
  }
  return answer(response, 404, { message: "Not Found" });
};

const call = (path: string, init: HarnessInit = {}): Promise<HarnessResponse> =>
  harness.fetch(path.startsWith("http") ? path : `${origin}${path}`, { redirect: "manual", ...init });

const signedIn = (email: string): Record<string, string> => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], email, iat: now, nbf: now, exp: now + 600 });
  const signature = sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), keyPair.privateKey).toString("base64url");
  return { "cf-access-jwt-assertion": `${head}.${payload}.${signature}`, origin };
};

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

const signUp = async (email: string, name: string): Promise<string> => {
  const answered = await call("/v1/tenants", {
    method: "POST",
    headers: { ...signedIn(email), "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  assert.equal(answered.status, 200);
  return WhoamiSchema.parse(await answered.json()).tenant.tenantId;
};

const bearerFor = async (email: string, tenantId: string): Promise<Record<string, string>> => {
  const registered = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: "github" }),
  });
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
  const cookie = ((await call(url.toString(), { headers: signedIn(email) })).headers.get("set-cookie") ?? "").split(
    ";",
  )[0];
  const consented = await call(url.pathname, {
    method: "POST",
    headers: { ...signedIn(email), cookie: cookie ?? "", "content-type": "application/x-www-form-urlencoded" },
    body: form({
      request: url.searchParams.get("request") ?? "",
      csrf: (cookie ?? "").slice(CSRF_COOKIE.length + 1),
      tenant: tenantId,
      action: "approve",
    }),
  });
  assert.equal(consented.status, 303);
  const redeemed = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      code: new URL(consented.headers.get("location") ?? "").searchParams.get("code") ?? "",
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
    }),
  });
  assert.equal(redeemed.status, 200);
  return { authorization: `Bearer ${OAuthTokenSchema.parse(await redeemed.json()).access_token}` };
};

const startedState = async (email: string, tenantId: string): Promise<string> => {
  const started = await call("/v1/github-connection/start", {
    method: "POST",
    headers: await bearerFor(email, tenantId),
  });
  assert.equal(started.status, 200);
  return new URL(GitHubInstallStartSchema.parse(await started.json()).installUrl).searchParams.get("state") ?? "";
};

const installed = (email: string, code: string, installationId: number, state?: string): Promise<HarnessResponse> =>
  call(
    `/github/app/installed?${form({ code, installation_id: String(installationId), setup_action: "install", ...(state === undefined ? {} : { state }) })}`,
    { headers: signedIn(email) },
  );

const confirm = (email: string, fields: Record<string, string>, from = origin): Promise<HarnessResponse> =>
  call("/github/app/installed", {
    method: "POST",
    headers: { ...signedIn(email), origin: from, "content-type": "application/x-www-form-urlencoded" },
    body: form(fields),
  });

const linkedTenant = async (installationId: number): Promise<string | null> => {
  const env = await harness.getWorker<{ DB: Database }>().getEnv();
  const row = await env.DB.prepare("SELECT tenant_id FROM github_installations WHERE installation_id = ?")
    .bind(installationId)
    .first<{ tenant_id: string }>();
  return row?.tenant_id ?? null;
};

const refusedPage = async (response: HarnessResponse, status: number, reason: RegExp): Promise<void> => {
  assert.equal(response.status, status);
  const html = await response.text();
  assert.match(html, reason);
  assert.match(html, />Connect from Tumpel</);
};

before(async () => {
  fakeGitHub = createServer((request, response) => void gitHubStandIn(request, response));
  await new Promise<void>((resolve) => fakeGitHub.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(fakeGitHub.address() as AddressInfo).port}`;
  harness = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          TUMPEL_SETTINGS: TEST_SETTINGS,
          ACCESS_ISSUER: issuer,
          ACCESS_AUD: AUDIENCE,
          SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
          DASHBOARD_ORIGIN: "https://app.tumpel.test",
          GITHUB_API_ORIGIN: issuer,
          GITHUB_WEB_ORIGIN: issuer,
        },
      },
    ],
  });
  origin = (await harness.listen()).url.origin;
  await harness.getWorker().applyD1Migrations("DB");
  const setup = await (await call("/github/app/setup", { headers: signedIn(VICTIM) })).text();
  const state = decodeURIComponent(/[?&]state=([^"&]+)/.exec(setup)?.[1] ?? "");
  const created = await call(`/github/app/created?${form({ code: "conversion-code", state })}`, {
    headers: signedIn(VICTIM),
  });
  assert.equal(created.status, 200);
  victimTenant = await signUp(VICTIM, "Victim");
  malloryTenant = await signUp(MALLORY, "Mallory");
});

after(async () => {
  await harness?.close();
  fakeGitHub?.close();
});

const identityState = (response: HarnessResponse): string => {
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(`${location.origin}${location.pathname}`, `${issuer}/login/oauth/authorize`);
  assert.equal(location.searchParams.get("client_id"), "Iv23client");
  assert.equal(location.searchParams.get("redirect_uri"), `${origin}/github/app/installed`);
  return location.searchParams.get("state") ?? "";
};

const identified = (email: string, code: string, state: string): Promise<HarnessResponse> =>
  call(`/github/app/installed?${form({ code, state })}`, { headers: signedIn(email) });

test("an attacker's install callback opened in a victim's session ignores the attacker's code and checks the victim's own GitHub account", async () => {
  const redirected = await installed(VICTIM, "mallory-code", 77);
  assert.doesNotMatch(redirected.headers.get("location") ?? "", /mallory-code/);
  const victims = identityState(redirected);

  const refused = await identified(VICTIM, "victim-code", victims);
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /installation 77 is not among the installations/);
  assert.equal(await linkedTenant(77), null);

  const mallorys = identityState(await installed(MALLORY, "mallory-code", 77));
  await refusedPage(await identified(VICTIM, "mallory-code", mallorys), 403, /started by mallory@example.test/);
  assert.equal(await linkedTenant(77), null);
});

test("an install made directly on GitHub links after the installer signs in to GitHub and confirms on the form", async () => {
  const state = identityState(await installed(VICTIM, "stale-code", 66));
  const page = await identified(VICTIM, "victim-code", state);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Connect victim to Victim/);
  assert.equal(await linkedTenant(66), null);

  const choice = /name="choice" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const fields = { choice, tenant: victimTenant };
  await refusedPage(await confirm(VICTIM, fields, "https://evil.test"), 403, /only this control plane/);
  await refusedPage(await confirm(MALLORY, fields), 403, /confirmed for victim@example.test/);
  assert.equal(await linkedTenant(66), null);

  assert.equal((await confirm(VICTIM, fields)).status, 200);
  assert.equal(await linkedTenant(66), victimTenant);
});

const delivered = async (installation: unknown, senderId: number): Promise<number> => {
  const body = JSON.stringify({ action: "created", installation, sender: { id: senderId, login: "someone" } });
  const signature = createHmac("sha256", "webhook-secret").update(body).digest("hex");
  const answered = await call("/github/webhook", {
    method: "POST",
    headers: { "x-github-event": "installation", "x-hub-signature-256": `sha256=${signature}` },
    body,
  });
  return answered.status;
};

test("an organization install connects only for the GitHub account its installation notice names, whichever arrives first", async () => {
  const mallorys = await startedState(MALLORY, malloryTenant);
  await refusedPage(await installed(VICTIM, "victim-code", 88, mallorys), 403, /started by mallory@example.test/);

  const victims = await startedState(VICTIM, victimTenant);
  await refusedPage(await installed(VICTIM, "victim-code", 88, victims), 409, /GitHub has not named the installer yet/);
  assert.equal(await linkedTenant(88), null);

  assert.equal(await delivered(ORG_INSTALLATION, 1), 204);
  await refusedPage(await installed(VICTIM, "coowner-code", 88, victims), 403, /coowner, who did not install the App/);
  assert.equal(await linkedTenant(88), null);

  assert.equal((await installed(VICTIM, "victim-code", 88, victims)).status, 200);
  assert.equal(await linkedTenant(88), victimTenant);
});

const RETURN_URL = "https://app.tumpel.test/t/rival/connections?tab=github";

const pickerStart = async (email: string, tenantId: string): Promise<string> => {
  const started = await call(`/v1/github-connection/start?${form({ returnUrl: RETURN_URL })}`, {
    method: "POST",
    headers: await bearerFor(email, tenantId),
  });
  assert.equal(started.status, 200);
  const installUrl = new URL(GitHubInstallStartSchema.parse(await started.json()).installUrl);
  assert.equal(`${installUrl.origin}${installUrl.pathname}`, "https://github.com/apps/tumpel-test/installations/new");
  assert.deepEqual([...installUrl.searchParams.keys()], ["state"]);
  return installUrl.searchParams.get("state") ?? "";
};

const returnedTo = (response: HarnessResponse): Record<string, string> => {
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(`${location.origin}${location.pathname}`, "https://app.tumpel.test/t/rival/connections");
  const { tab, ...outcome } = Object.fromEntries(location.searchParams);
  assert.equal(tab, "github");
  return outcome;
};

test("adding an account opens GitHub's install picker, and every outcome returns to the dashboard page that started it", async () => {
  const rivalTenant = await signUp(RIVAL, "Rival");
  const secondTenant = await signUp(RIVAL, "Rival Two");

  const linked = await installed(RIVAL, "rival-code", 130, await pickerStart(RIVAL, rivalTenant));
  assert.deepEqual(returnedTo(linked), { from: "github" });
  assert.equal(await linkedTenant(130), rivalTenant);

  const held = await installed(RIVAL, "rival-code", 130, await pickerStart(RIVAL, secondTenant));
  assert.deepEqual(returnedTo(held), { from: "github", refused: "OtherTenant", account: "rival" });
  assert.equal(await linkedTenant(130), rivalTenant);

  const notInstaller = await installed(RIVAL, "rival-code", 77, await pickerStart(RIVAL, secondTenant));
  assert.deepEqual(returnedTo(notInstaller), { from: "github", refused: "NotInstaller", account: "mallory" });

  const unknown = await installed(RIVAL, "rival-code", 131, await pickerStart(RIVAL, secondTenant));
  assert.deepEqual(returnedTo(unknown), { from: "github", refused: "InstallerUnknown", account: "rivalorg" });
  assert.equal(await linkedTenant(131), null);

  const failed = returnedTo(await installed(RIVAL, "nobody-code", 131, await pickerStart(RIVAL, secondTenant)));
  assert.equal(failed.from, "github");
  assert.match(failed.failed ?? "", /Bad credentials|401/);
});

test("the installation list names each account type, reading it once from GitHub for an installation stored without one", async () => {
  const tenantId = await signUp(LISTER, "Lister");
  const env = await harness.getWorker<{ DB: Database }>().getEnv();
  const insert =
    "INSERT INTO github_installations (installation_id, tenant_id, account_login, account_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'Active', ?, ?)";
  await env.DB.prepare(insert).bind(140, tenantId, "untyped", null, 1, 1).run();
  await env.DB.prepare(insert).bind(141, tenantId, "typedorg", "Organization", 2, 2).run();

  const listed = await call("/v1/github-connection/installations", { headers: await bearerFor(LISTER, tenantId) });
  assert.equal(listed.status, 200);
  const installations = GitHubInstallationSchema.array().parse(await listed.json());
  assert.deepEqual(
    installations.map(({ installationId, accountType }) => [installationId, accountType]),
    [
      [140, "User"],
      [141, "Organization"],
    ],
  );
  const stored = await env.DB.prepare("SELECT account_type FROM github_installations WHERE installation_id = ?")
    .bind(140)
    .first<{ account_type: string }>();
  assert.equal(stored?.account_type, "User");
});

test("a request an organization member makes directly on GitHub shows the requested page", async () => {
  const requested = await call(`/github/app/installed?${form({ setup_action: "request" })}`, {
    headers: signedIn(RIVAL),
  });
  assert.equal(requested.status, 202);
});

test("a repository is read from owner/name as from its GitHub URL, and anything else is no GitHub repository", () => {
  const app = { owner: "acme", name: "app" };
  for (const form of [
    "acme/app",
    "github.com/acme/app",
    "github.com/acme/app.git",
    "https://github.com/acme/app",
    "https://github.com/acme/app.git",
    " acme/app/ ",
  ]) {
    assert.deepEqual(githubRepository(form), app, form);
  }
  for (const form of ["acme", "acme/app/tree/main", "https://gitlab.com/acme/app", "github.com:acme/app"]) {
    assert.equal(githubRepository(form), null, form);
  }
});
