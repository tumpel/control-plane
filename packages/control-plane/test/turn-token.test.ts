import assert from "node:assert/strict";
import { test } from "node:test";
import { mintTurnToken, verifyTurnToken } from "../src/turn-token.ts";

const hmacKey = () =>
  crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

const CLAIMS = { tenantId: "tenant-1", principalId: "principal-1", sessionId: "session-1", turnId: "turn-1" };

test("a turn token verifies to its claims until it expires", async () => {
  const key = await hmacKey();
  const claims = { ...CLAIMS, expiresAt: 2_000 };
  const token = await mintTurnToken(key, claims);
  assert.deepEqual(await verifyTurnToken(key, token, 1_999), claims);
  assert.equal(await verifyTurnToken(key, token, 2_000), null);
});

test("a turn token fails when tampered with or signed by another key", async () => {
  const key = await hmacKey();
  const token = await mintTurnToken(key, { ...CLAIMS, expiresAt: 2_000 });
  const [body = "", signature = ""] = token.split(".");
  const forged = `${body.slice(0, -2)}${body.slice(-2) === "AA" ? "AB" : "AA"}.${signature}`;
  assert.equal(await verifyTurnToken(key, forged, 1_000), null);
  assert.equal(await verifyTurnToken(key, token.slice("tumpel-turn_".length), 1_000), null);
  assert.equal(await verifyTurnToken(await hmacKey(), token, 1_000), null);
});
