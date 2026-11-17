import assert from "node:assert/strict";
import { test } from "node:test";
import { accessTokenExpiry } from "../src/credential-file.ts";

const jwt = (claims: object): string =>
  `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;

test("the expiry of a rewritten auth.json comes from the exp claim of its access token", () => {
  const auth = JSON.stringify({
    tokens: { id_token: "x", access_token: jwt({ sub: "u", exp: 1795000000 }), refresh_token: "r", account_id: "a" },
  });
  assert.equal(accessTokenExpiry(auth), "2026-11-18T11:06:40.000Z");
});

test("an auth.json without a readable access token expiry yields none", () => {
  assert.equal(accessTokenExpiry("not json"), null);
  assert.equal(accessTokenExpiry(JSON.stringify({ OPENAI_API_KEY: "sk-1" })), null);
  assert.equal(accessTokenExpiry(JSON.stringify({ tokens: { access_token: "opaque" } })), null);
  assert.equal(accessTokenExpiry(JSON.stringify({ tokens: { access_token: jwt({ sub: "u" }) } })), null);
});
