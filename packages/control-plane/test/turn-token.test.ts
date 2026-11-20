import assert from "node:assert/strict";
import { test } from "node:test";
import { mintTurnToken, turnTokenLive, verifyTurnToken } from "../src/turn-token.ts";

test("a turn token authorizes only while its turn runs in its session", async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const token = await mintTurnToken(key, {
    tenantId: "tenant-1",
    principalId: "principal-1",
    sessionId: "session-1",
    turnId: "turn-1",
    expiresAt: 2_000,
  });
  const claims = await verifyTurnToken(key, token, 1_000);
  assert.notEqual(claims, null);
  if (claims === null) return;
  assert.equal(turnTokenLive(claims, { sessionId: "session-1", state: "Running" }), true);
  assert.equal(turnTokenLive(claims, { sessionId: "session-1", state: "Completed" }), false);
  assert.equal(turnTokenLive(claims, { sessionId: "session-1", state: "Failed" }), false);
  assert.equal(turnTokenLive(claims, { sessionId: "session-2", state: "Running" }), false);
  assert.equal(turnTokenLive(claims, null), false);
  assert.equal(await verifyTurnToken(key, token, 2_000), null);
});
