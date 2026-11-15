import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceAuthorization,
  CIRCLECI_REDIRECT_URI,
  credentialStanding,
  parseRedirect,
  RENEWAL_WINDOW_MS,
} from "../src/circleci-oauth.ts";

const ID = "auth-1";

test("a pasted redirect address yields its code and state", () => {
  assert.deepEqual(parseRedirect(`  ${CIRCLECI_REDIRECT_URI}?code=abc123&state=s-1\n`, CIRCLECI_REDIRECT_URI), {
    kind: "Code",
    code: "abc123",
    state: "s-1",
  });
});

test("a denied consent yields its error even beside a code", () => {
  assert.deepEqual(
    parseRedirect(
      `${CIRCLECI_REDIRECT_URI}?error=access_denied&error_description=the+user+denied+the+request&state=s-1&code=x`,
      CIRCLECI_REDIRECT_URI,
    ),
    { kind: "Denied", error: "access_denied", description: "the user denied the request", state: "s-1" },
  );
});

test("the parser refuses what is not this redirect address with one state and a code", () => {
  const refused = [
    "abc123",
    "https://dev.tumpel.dev/circleci/callback?code=a&state=s",
    "http://127.0.0.1:47152/circleci/callback?code=a&state=s",
    "http://localhost:47151/circleci/callback?code=a&state=s",
    `${CIRCLECI_REDIRECT_URI}/extra?code=a&state=s`,
    `${CIRCLECI_REDIRECT_URI}?code=a`,
    `${CIRCLECI_REDIRECT_URI}?code=a&state=s&state=t`,
    `${CIRCLECI_REDIRECT_URI}?code=a&state=`,
    `${CIRCLECI_REDIRECT_URI}?state=s`,
    `${CIRCLECI_REDIRECT_URI}?code=&state=s`,
  ];
  for (const raw of refused) {
    const parsed = parseRedirect(raw, CIRCLECI_REDIRECT_URI);
    assert.equal(parsed.kind, "Invalid", raw);
    assert.ok(parsed.kind === "Invalid" && parsed.detail.includes(CIRCLECI_REDIRECT_URI), raw);
  }
});

test("each event proceeds only in its own phase", () => {
  assert.deepEqual(advanceAuthorization(ID, "AwaitingRedirect", { kind: "Redirected" }), { kind: "Proceed" });
  assert.deepEqual(advanceAuthorization(ID, "ChoosingOrganization", { kind: "Chosen" }), { kind: "Proceed" });
  for (const state of ["ChoosingOrganization", "Completed", "Failed"] as const) {
    const step = advanceAuthorization(ID, state, { kind: "Redirected" });
    assert.equal(step.kind, "Refuse", state);
    assert.match(step.kind === "Refuse" ? step.detail : "", new RegExp(`is ${state} and takes no redirect address`));
  }
  for (const state of ["AwaitingRedirect", "Completed", "Failed"] as const) {
    assert.equal(advanceAuthorization(ID, state, { kind: "Chosen" }).kind, "Refuse", state);
  }
});

test("a deadline fails a live phase AuthorizationTimedOut and leaves an ended one", () => {
  for (const state of ["AwaitingRedirect", "ChoosingOrganization"] as const) {
    const step = advanceAuthorization(ID, state, { kind: "Deadline" });
    assert.equal(step.kind === "Fail" && step.reason, "AuthorizationTimedOut", state);
  }
  for (const state of ["Completed", "Failed"] as const) {
    assert.deepEqual(advanceAuthorization(ID, state, { kind: "Deadline" }), { kind: "Ignore" });
  }
});

test("an authorized token reads Expiring inside the renewal window and Reconnect from its expiry", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");
  assert.deepEqual(credentialStanding(null, now), { state: "Connected" });
  assert.deepEqual(credentialStanding(now + RENEWAL_WINDOW_MS + 1, now), { state: "Connected" });
  assert.deepEqual(credentialStanding(now + RENEWAL_WINDOW_MS, now), {
    state: "Expiring",
    expiresAt: new Date(now + RENEWAL_WINDOW_MS).toISOString(),
  });
  assert.deepEqual(credentialStanding(now, now), { state: "Reconnect", expiredAt: new Date(now).toISOString() });
});
