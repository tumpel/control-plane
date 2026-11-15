import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { deriveSigningKey } from "../src/envelope.ts";
import {
  appManifest,
  convertManifest,
  type Fetch,
  importAppKey,
  mintInstallationToken,
  pkcs8FromPem,
  readState,
  repositoryCredential,
  signState,
  verifyInstaller,
  verifyWebhookSignature,
  withRepositoryToken,
} from "../src/github.ts";
import { GitHubInstallStateSchema, GitHubManifestStateSchema } from "../src/github-schemas.ts";

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
  const answer = await convertManifest(fetcher, "code/1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.github.com/app-manifests/code%2F1/conversions");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(header(calls[0]?.init ?? {}, "authorization"), null);
  assert.ok(answer.ok);
  assert.equal(answer.value.id, 42);
  assert.equal(answer.value.owner.login, "octo");

  const refused = await convertManifest(spiedFetch(404, { message: "Not Found" }).fetcher, "spent");
  assert.ok(!refused.ok);
  assert.match(refused.detail, /404: Not Found/);
});

test("the manifest returns installs and deliveries to the control plane and asks for no admin-level permission", () => {
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
  for (const permission of ["administration", "members", "organization_administration", "secrets"]) {
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

test("an installation token is minted for the session's repository with a JWT the App's key signs", async () => {
  const now = Date.parse("2026-11-15T10:00:00Z");
  const app = { clientId: "Iv23client", privateKey: await importAppKey(pkcs8FromPem(pkcs1Pem)) };
  const installation = { installationId: 7, accountLogin: "Octo" };
  const { fetcher, calls } = spiedFetch(201, { token: "ghs_minted", expires_at: "2026-11-15T11:00:00Z" });

  const minted = await mintInstallationToken(fetcher, app, installation, "https://github.com/octo/widgets.git", now);
  assert.deepEqual(minted, { kind: "Minted", token: "ghs_minted", expiresAt: "2026-11-15T11:00:00Z" });
  assert.equal(calls[0]?.url, "https://api.github.com/app/installations/7/access_tokens");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { repositories: ["widgets"] });

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
  const installation = { installationId: 7, accountLogin: "octo" };

  const notCovered = await mintInstallationToken(
    spiedFetch(422, { message: "There is at least one repository that does not exist or is not accessible" }).fetcher,
    app,
    installation,
    "https://github.com/octo/private",
    now,
  );
  assert.equal(notCovered.kind, "Outside");
  assert.match(notCovered.kind === "Outside" ? notCovered.detail : "", /422: There is at least one repository/);
  assert.match(notCovered.kind === "Outside" ? notCovered.detail : "", /github\.com\/settings\/installations\/7/);

  const down = await mintInstallationToken(
    spiedFetch(503, { message: "Service Unavailable" }).fetcher,
    app,
    installation,
    "https://github.com/octo/private",
    now,
  );
  assert.equal(down.kind, "Refused");
  assert.doesNotMatch(down.kind === "Refused" ? down.detail : "", /add octo\/private/);

  const elsewhere = spiedFetch(201, {});
  const foreign = await mintInstallationToken(elsewhere.fetcher, app, installation, "https://github.com/acme/x", now);
  assert.equal(foreign.kind, "Outside");
  assert.equal(elsewhere.calls.length, 0);

  const notGitHub = await mintInstallationToken(elsewhere.fetcher, app, installation, "https://gitlab.com/octo/x", now);
  assert.deepEqual(notGitHub, { kind: "NoToken" });
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

test("an installation links only when the person who authorized the App can access it", async () => {
  const listed = { total_count: 1, installations: [{ id: 7, account: { login: "octo" } }] };

  const owned = answering([
    [200, { access_token: "ghu_user", token_type: "bearer", scope: "" }],
    [200, listed],
  ]);
  const installer = await verifyInstaller(owned.fetcher, oauthClient, "code-1", 7);
  assert.deepEqual(installer, { kind: "Installer", installation: { id: 7, account: { login: "octo" } } });
  assert.equal(owned.calls[0]?.url, "https://github.com/login/oauth/access_token");
  assert.equal(header(owned.calls[0]?.init ?? {}, "accept"), "application/json");
  assert.deepEqual(JSON.parse(String(owned.calls[0]?.init.body)), {
    client_id: "Iv23client",
    client_secret: "client-secret",
    code: "code-1",
  });
  assert.equal(owned.calls[1]?.url, "https://api.github.com/user/installations?per_page=100");
  assert.equal(header(owned.calls[1]?.init ?? {}, "authorization"), "Bearer ghu_user");

  const someoneElses = answering([
    [200, { access_token: "ghu_user", token_type: "bearer", scope: "" }],
    [200, listed],
  ]);
  const refused = await verifyInstaller(someoneElses.fetcher, oauthClient, "code-1", 8);
  assert.equal(refused.kind, "NotInstaller");

  const spent = answering([[200, { error: "bad_verification_code", error_description: "The code is incorrect." }]]);
  const failed = await verifyInstaller(spent.fetcher, oauthClient, "spent", 7);
  assert.equal(failed.kind, "Failed");
  assert.equal(spent.calls.length, 1);
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
