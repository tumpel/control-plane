import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { IssuerJwksSchema } from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { d1Issuer, ISSUER_KEY_OVERLAP_MS, type IssuerDatabase, type IssuerJwk } from "../src/issuer.ts";
import { workersSecretKeyStore } from "../src/key-store.ts";

const ISSUER = "https://id.test.tumpel.dev";
const KEK = Buffer.alloc(32, 7).toString("base64");
const SUBJECT = "tenant:7d1c6c9e-0b1f-4f43-9a51-3c1f8f0b2a10:persona:proof:job:prebuild";

let server: TestHarness;
let db: IssuerDatabase;

before(async () => {
  server = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [{ configPath: "./wrangler.jsonc", vars: { SECRETS_KEK: KEK, ISSUER_HOSTNAME: "id.test.tumpel.dev" } }],
  });
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  db = (await server.getWorker<{ DB: IssuerDatabase }>().getEnv()).DB;
});

after(async () => {
  await server?.close();
});

const segment = (token: string, index: number): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[index] ?? "", "base64url").toString("utf8"));

const verifies = (token: string, keys: IssuerJwk[]): boolean => {
  const kid = segment(token, 0).kid;
  const jwk = keys.find((key) => key.kid === kid);
  if (jwk === undefined) return false;
  const [header, payload, signature] = token.split(".");
  return verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" }),
    Buffer.from(signature ?? "", "base64url"),
  );
};

test("a token verifies against the published JWK and carries the issuer, subject, audience and a 300 s life", async () => {
  const at = Date.parse("2026-11-15T10:00:00Z");
  const issuer = d1Issuer(db, workersSecretKeyStore(KEK), ISSUER, () => at);
  const issued = await issuer.signIssuerToken(SUBJECT, "federation.namespaceapis.com", { job: "prebuild" });
  const keys = await issuer.publishedKeys();

  assert.ok(verifies(issued.token, keys));
  assert.deepEqual(segment(issued.token, 0), { alg: "RS256", typ: "JWT", kid: issued.kid });
  const claims = segment(issued.token, 1);
  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.sub, SUBJECT);
  assert.equal(claims.aud, "federation.namespaceapis.com");
  assert.equal(claims.job, "prebuild");
  assert.equal(Number(claims.exp) - Number(claims.iat), 300);
  assert.equal(issued.expiresAt, at - (at % 1000) + 300_000);
  assert.ok(!verifies(`${issued.token.slice(0, -4)}AAAA`, keys));
});

test("after a rotation both keys verify until the old one retires, and then the old key leaves the JWKS", async () => {
  let now = Date.parse("2026-11-15T11:00:00Z");
  const issuer = d1Issuer(db, workersSecretKeyStore(KEK), ISSUER, () => now);
  const before = await issuer.signIssuerToken(SUBJECT, "sts.amazonaws.com", {});

  now += 1_000;
  const rotation = await issuer.rotate();
  assert.notEqual(rotation.kid, before.kid);
  assert.deepEqual(rotation.retiring, [{ kid: before.kid, retiresAt: now + ISSUER_KEY_OVERLAP_MS }]);
  const after = await issuer.signIssuerToken(SUBJECT, "sts.amazonaws.com", {});
  assert.equal(after.kid, rotation.kid);

  now += ISSUER_KEY_OVERLAP_MS - 1;
  const overlapping = await issuer.publishedKeys();
  assert.deepEqual(
    overlapping.map((key) => key.kid),
    [rotation.kid, before.kid],
  );
  assert.ok(verifies(before.token, overlapping));
  assert.ok(verifies(after.token, overlapping));

  now += 1;
  const retired = await issuer.publishedKeys();
  assert.deepEqual(
    retired.map((key) => key.kid),
    [rotation.kid],
  );
  assert.ok(!verifies(before.token, retired));
  assert.ok(verifies(after.token, retired));
});

test("the issuer hostname serves the discovery document and the JWKS, and nothing else", async () => {
  const configuration = await server.fetch(`${ISSUER}/.well-known/openid-configuration`);
  assert.equal(configuration.status, 200);
  assert.deepEqual(await configuration.json(), {
    issuer: ISSUER,
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  });

  const jwks = await server.fetch(`${ISSUER}/.well-known/jwks.json`);
  assert.equal(jwks.status, 200);
  const { keys } = IssuerJwksSchema.parse(await jwks.json());
  assert.ok(keys.length >= 1);
  assert.ok(keys.every((key) => key.kty === "RSA" && key.alg === "RS256" && key.use === "sig"));

  for (const path of ["/healthz", "/v1/whoami", "/.well-known/oauth-authorization-server"]) {
    assert.equal((await server.fetch(`${ISSUER}${path}`)).status, 404, path);
  }
  assert.equal((await server.fetch("https://api.test.tumpel.dev/.well-known/jwks.json")).status, 404);
});
