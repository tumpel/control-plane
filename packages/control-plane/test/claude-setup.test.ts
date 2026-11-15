import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, type ClaudeSetupRow, setupOffer } from "../src/claude-setup.ts";

const budgets = {
  claudeSetupUrlBudgetSeconds: 300,
  claudeSetupCodeBudgetSeconds: 600,
  claudeSetupMintBudgetSeconds: 120,
};

test("each phase advances on its own event, fails on its budget with its named reason, and refuses a code out of turn", () => {
  const cases = [
    {
      state: "Starting",
      event: { kind: "Url", signInUrl: "https://claude.ai/oauth/authorize?x=1" },
      kind: "Advance",
      next: "AwaitingCode",
      due: 600,
    },
    { state: "AwaitingCode", event: { kind: "Code" }, kind: "Advance", next: "Minting", due: 120 },
    { state: "Minting", event: { kind: "Stored" }, kind: "Complete" },
    { state: "Starting", event: { kind: "Deadline" }, kind: "Fail", reason: "SetupUrlMissing" },
    { state: "AwaitingCode", event: { kind: "Deadline" }, kind: "Fail", reason: "SetupTimedOut" },
    { state: "Minting", event: { kind: "Deadline" }, kind: "Fail", reason: "SetupTimedOut" },
    {
      state: "Minting",
      event: { kind: "BoxFailed", reason: "CodeRejected", detail: "refused" },
      kind: "Fail",
      reason: "CodeRejected",
    },
    { state: "Starting", event: { kind: "Code" }, kind: "Refuse" },
    { state: "Minting", event: { kind: "Code" }, kind: "Refuse" },
    { state: "AwaitingCode", event: { kind: "Stored" }, kind: "Refuse" },
    { state: "Completed", event: { kind: "Code" }, kind: "Refuse" },
    { state: "Failed", event: { kind: "Deadline" }, kind: "Ignore" },
    { state: "AwaitingCode", event: { kind: "Url", signInUrl: "https://claude.ai/again" }, kind: "Ignore" },
  ] as const;
  for (const each of cases) {
    const step = advance("setup-1", each.state, each.event, budgets);
    assert.equal(step.kind, each.kind, `${each.state} on ${each.event.kind}`);
    if (step.kind === "Advance" && "next" in each) {
      assert.equal(step.state, each.next);
      assert.equal(step.dueInSeconds, each.due);
    }
    if (step.kind === "Fail" && "reason" in each) assert.equal(step.reason, each.reason);
  }
});

test("the setup offer carries the box's image, its token URL and credential, and no secret set grant or GitHub token", () => {
  const row: ClaudeSetupRow = {
    claude_setup_id: "setup-1",
    principal_id: "principal-1",
    secret_set_id: "set-1",
    host_id: "host-1",
    box_id: "box-1",
    harness_version: "2.1.0",
    endpoint: "https://api.example.test",
    state: "Starting",
    phase_due_at: 1_000_300_000,
    sign_in_url: null,
    reason: null,
    detail: null,
    expires_at: null,
    ended_at: null,
    created_at: 1_000_000_000,
    updated_at: 1_000_000_000,
  };
  const image = {
    imageDigest: "a".repeat(64),
    kernelDigest: "b".repeat(64),
    manifestDigest: "c".repeat(64),
    imageUrl: "https://r2.example.test/image",
    kernelUrl: "https://r2.example.test/kernel",
    manifestUrl: "https://r2.example.test/manifest",
    downloadExpiresAt: "2001-09-09T01:51:40.000Z",
    fetchSeconds: 300,
  };
  const offer = setupOffer("tenant-1", row, image, "t".repeat(43), budgets);
  assert.deepEqual(Object.keys(offer).sort(), [
    "boxId",
    "claudeSetupId",
    "expiresAt",
    "harnessVersion",
    "image",
    "tenantId",
    "tokenCredential",
    "tokenUrl",
    "type",
  ]);
  assert.equal(offer.tokenUrl, "https://api.example.test/v1/claude-setups/setup-1/token");
  assert.match(offer.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
});
