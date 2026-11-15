import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceAuthorization,
  CALLBACK_PATH,
  callbackUrl,
  parseCallback,
  readState,
  signState,
  stateOfPath,
} from "../src/openrouter-oauth.ts";

const ID = "auth-1";
const CLAIMS = { purpose: "OpenRouterAuthorization", tenantId: "tenant-1", openRouterAuthorizationId: ID } as const;

const hmacKey = (seed: number): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", new Uint8Array(32).fill(seed), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

test("a callback yields its one code, and none when OpenRouter sends the browser back without one", () => {
  assert.deepEqual(parseCallback(new URLSearchParams("code=abc123&state=x")), { kind: "Code", code: "abc123" });
  assert.deepEqual(parseCallback(new URLSearchParams("")), { kind: "NoCode" });
  assert.deepEqual(parseCallback(new URLSearchParams("error=access_denied")), { kind: "NoCode" });
});

test("the parser refuses an empty code and several codes", () => {
  for (const search of ["code=", "code=a&code=b"]) {
    assert.equal(parseCallback(new URLSearchParams(search)).kind, "Invalid", search);
  }
});

test("a signed state reads back on the callback path it was minted for", async () => {
  const key = await hmacKey(1);
  const state = await signState(key, CLAIMS);
  const url = new URL(callbackUrl("https://api.tumpel.dev", state));
  assert.equal(url.pathname, `${CALLBACK_PATH}${state}`);
  const read = stateOfPath(url.pathname);
  assert.equal(read, state);
  assert.deepEqual(await readState(key, read ?? ""), { ok: true, claims: CLAIMS });
});

test("the callback refuses a state another key signed, a tampered one and a malformed one", async () => {
  const state = await signState(await hmacKey(1), CLAIMS);
  const key = await hmacKey(1);
  const [body, signature] = state.split(".");
  const forged = `${btoa(JSON.stringify({ ...CLAIMS, tenantId: "tenant-2" }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}.${signature}`;
  assert.equal((await readState(await hmacKey(2), state)).ok, false);
  assert.equal((await readState(key, forged)).ok, false);
  for (const malformed of [body ?? "", `${state}.extra`, "not base64!.x", ""]) {
    assert.equal((await readState(key, malformed)).ok, false, malformed);
  }
});

test("only a single path segment after the callback prefix is a state", () => {
  assert.equal(stateOfPath(`${CALLBACK_PATH}`), null);
  assert.equal(stateOfPath(`${CALLBACK_PATH}a/b`), null);
  assert.equal(stateOfPath("/openrouter/other/a"), null);
});

test("a callback proceeds only while the authorization awaits it and before its due time", () => {
  assert.deepEqual(advanceAuthorization(ID, "AwaitingCallback", { kind: "Callback", now: 1, dueAt: 2 }), {
    kind: "Proceed",
  });
  const late = advanceAuthorization(ID, "AwaitingCallback", { kind: "Callback", now: 2, dueAt: 2 });
  assert.equal(late.kind === "Fail" && late.reason, "AuthorizationTimedOut");
  for (const ended of ["Completed", "Failed"] as const) {
    assert.equal(advanceAuthorization(ID, ended, { kind: "Callback", now: 1, dueAt: 2 }).kind, "Refuse");
  }
});

test("the deadline fails a waiting authorization and leaves an ended one alone", () => {
  const due = advanceAuthorization(ID, "AwaitingCallback", { kind: "Deadline" });
  assert.equal(due.kind === "Fail" && due.reason, "AuthorizationTimedOut");
  assert.deepEqual(advanceAuthorization(ID, "Completed", { kind: "Deadline" }), { kind: "Ignore" });
  assert.deepEqual(advanceAuthorization(ID, "Failed", { kind: "Deadline" }), { kind: "Ignore" });
});
