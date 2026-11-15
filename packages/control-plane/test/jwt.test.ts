import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mock, test } from "node:test";
import { jwtVerifier } from "../src/jwt.ts";

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

const signed = (header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject): string => {
  const body = `${encode(header)}.${encode(claims)}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), key).toString("base64url")}`;
};

test("a JWT is accepted when the issuer's key signed it for this audience, and refused naming the failed check", async () => {
  const issuer = "https://jobs.example.test";
  const keysUrl = `${issuer}/.well-known/jwks`;
  const audience = "https://api.example.test";
  const job = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const published = { ...job.publicKey.export({ format: "jwk" }), kid: "rsa-key", alg: "RS256", use: "sig" };
  const fetched: string[] = [];
  const fetchSpy = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    fetched.push(String(input));
    return Response.json({ keys: [published, { kty: "OKP", kid: "skipped" }] });
  });
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: issuer, aud: audience, exp: now + 300, nbf: now, repository: "acme/app" };
  const token = (overrides: Record<string, unknown>, kid = "rsa-key", key = job.privateKey) =>
    signed({ alg: "RS256", kid, typ: "JWT" }, { ...claims, ...overrides }, key);
  const verify = jwtVerifier(keysUrl, issuer, audience);

  const accepted = await verify(token({}));
  assert.ok(accepted.ok);
  assert.equal(accepted.claims.repository, "acme/app");
  assert.ok((await verify(token({ aud: [audience, "other"] }))).ok);
  assert.deepEqual(fetched, [keysUrl]);

  const refusals: [string, string][] = [
    [token({ aud: "https://github.com/acme" }), "aud"],
    [token({ aud: `${audience}/` }), "aud"],
    [token({ exp: now - 120 }), "exp"],
    [token({ nbf: now + 600 }), "nbf"],
    [token({ iss: "https://other.example.test" }), "iss"],
    [token({}, "unknown-key"), "kid"],
    [token({}, "rsa-key", stranger.privateKey), "signature"],
    [signed({ alg: "HS256", kid: "rsa-key" }, claims, job.privateKey), "token"],
    ["not-a-jwt", "token"],
  ];
  for (const [refused, check] of refusals) {
    const verified = await verify(refused);
    assert.ok(!verified.ok, check);
    assert.equal(verified.check, check);
  }
  assert.deepEqual(fetched, [keysUrl], "an unknown kid inside the refresh floor fetches no keys again");
  fetchSpy.mock.restore();
});
