import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discover,
  refreshBundle,
  refusedAddress,
  singleFlight,
  tenantOfTurnToken,
  turnToken,
  turnTokenMatches,
} from "../src/connector-oauth.ts";
import type { Fetch } from "../src/github.ts";

const served =
  (documents: Record<string, { status: number; body: unknown }>): Fetch =>
  async (url) => {
    const document = documents[url];
    if (document === undefined) return new Response("not found", { status: 404 });
    return Response.json(document.body, { status: document.status });
  };

const RESOURCE = {
  status: 200,
  body: { resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"] },
};

const SERVER = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register",
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["read", "offline_access"],
};

test("refusedAddress blocks private, loopback, link-local and local hosts and plain http", () => {
  for (const blocked of [
    "http://mcp.example.com/mcp",
    "https://localhost/mcp",
    "https://box.localhost/mcp",
    "https://printer.local/mcp",
    "https://127.0.0.1/mcp",
    "https://10.1.2.3/mcp",
    "https://172.20.0.1/mcp",
    "https://192.168.1.1/mcp",
    "https://169.254.169.254/latest",
    "https://100.64.0.1/mcp",
    "https://[::1]/mcp",
    "https://[fe80::1]/mcp",
    "https://[fd00::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
  ]) {
    assert.notEqual(refusedAddress(blocked), null, blocked);
  }
  assert.equal(refusedAddress("https://mcp.example.com/mcp"), null);
  assert.equal(refusedAddress("https://8.8.8.8/mcp"), null);
});

test("discover pins the resource and issuer and asks offline_access when advertised", async () => {
  const found = await discover(
    served({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": RESOURCE,
      "https://auth.example.com/.well-known/oauth-authorization-server": { status: 200, body: SERVER },
    }),
    "https://mcp.example.com/mcp",
  );
  assert.equal(found.kind, "Discovered");
  if (found.kind !== "Discovered") return;
  assert.equal(found.discovered.issuer, "https://auth.example.com");
  assert.equal(found.discovered.resource, "https://mcp.example.com/mcp");
  assert.deepEqual(found.discovered.scopes, ["read", "offline_access"]);
});

test("discover refuses a server without dynamic client registration", async () => {
  const { registration_endpoint: _, ...unregistered } = SERVER;
  const found = await discover(
    served({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": RESOURCE,
      "https://auth.example.com/.well-known/oauth-authorization-server": { status: 200, body: unregistered },
    }),
    "https://mcp.example.com/mcp",
  );
  assert.equal(found.kind, "RegistrationUnsupported");
});

test("discover refuses a foreign resource, a renamed issuer, no S256, a private endpoint and a redirect", async () => {
  const cases: Record<string, { status: number; body: unknown }>[] = [
    {
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
        status: 200,
        body: { resource: "https://other.example.com/mcp", authorization_servers: ["https://auth.example.com"] },
      },
    },
    {
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": RESOURCE,
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        status: 200,
        body: { ...SERVER, issuer: "https://evil.example.com" },
      },
    },
    {
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": RESOURCE,
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        status: 200,
        body: { ...SERVER, code_challenge_methods_supported: ["plain"] },
      },
    },
    {
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": RESOURCE,
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        status: 200,
        body: { ...SERVER, token_endpoint: "https://10.0.0.5/token" },
      },
    },
    { "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": { status: 302, body: null } },
  ];
  for (const documents of cases) {
    const found = await discover(served(documents), "https://mcp.example.com/mcp");
    assert.equal(found.kind, "DiscoveryFailed", JSON.stringify(documents));
  }
});

test("refreshBundle keeps the refresh token the provider did not rotate and names invalid_grant", async () => {
  const endpoints = {
    issuer: "https://auth.example.com",
    resource: "https://mcp.example.com/mcp",
    tokenEndpoint: "https://auth.example.com/token",
  };
  const kept = await refreshBundle(
    served({ "https://auth.example.com/token": { status: 200, body: { access_token: "a2", expires_in: 60 } } }),
    endpoints,
    "client",
    "r1",
    1_000,
  );
  assert.deepEqual(kept, {
    kind: "Issued",
    bundle: { kind: "Refreshable", accessToken: "a2", refreshToken: "r1", expiresAt: 61_000 },
  });
  const refused = await refreshBundle(
    served({ "https://auth.example.com/token": { status: 400, body: { error: "invalid_grant" } } }),
    endpoints,
    "client",
    "r1",
    1_000,
  );
  assert.equal(refused.kind, "InvalidGrant");
});

test("a turn token admits only its own tenant, turn and connector", async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const token = await turnToken(key, "tenant-1", "turn-1", "connector-1");
  assert.equal(tenantOfTurnToken(token), "tenant-1");
  assert.equal(await turnTokenMatches(key, token, "turn-1", "connector-1"), true);
  assert.equal(await turnTokenMatches(key, token, "turn-2", "connector-1"), false);
  assert.equal(await turnTokenMatches(key, token, "turn-1", "connector-2"), false);
  assert.equal(await turnTokenMatches(key, token.replace("tenant-1", "tenant-2"), "turn-1", "connector-1"), false);
});

test("singleFlight runs one refresh for concurrent callers and a new one after it settles", async () => {
  const inFlight = new Map<string, Promise<number>>();
  let runs = 0;
  let release: (value: number) => void = () => undefined;
  const run = () => {
    runs += 1;
    return new Promise<number>((resolve) => {
      release = resolve;
    });
  };
  const first = singleFlight(inFlight, "connector-1", run);
  const second = singleFlight(inFlight, "connector-1", run);
  release(7);
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
  assert.equal(runs, 1);
  const third = singleFlight(inFlight, "connector-1", run);
  release(8);
  assert.equal(await third, 8);
  assert.equal(runs, 2);
});
