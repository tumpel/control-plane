import assert from "node:assert/strict";
import { test } from "node:test";
import { type MemberRow, planUpdate, storedKeys } from "../src/secret-members.ts";

const row = (fields: Partial<MemberRow> & Pick<MemberRow, "name" | "kind">): MemberRow => ({
  sealed: "sealed",
  updated_at: 1794686269152,
  provider: null,
  expires_at: null,
  ...fields,
});

test("a stored credential member without its provider or expiry row names the member instead of throwing", () => {
  const github = row({ name: "GITHUB_TOKEN", kind: "Variable" });
  const token = row({
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    kind: "SubscriptionToken",
    provider: "Anthropic",
    expires_at: "2026-11-16T00:28:10.761+00:00",
  });

  assert.deepEqual(storedKeys([token, github]), {
    kind: "Keys",
    keys: [
      {
        kind: "SubscriptionToken",
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        provider: "Anthropic",
        expiresAt: "2026-11-16T00:28:10.761+00:00",
        updatedAt: 1794686269152,
      },
      { kind: "Variable", name: "GITHUB_TOKEN", updatedAt: 1794686269152 },
    ],
  });

  const withoutExpiry = storedKeys([{ ...token, expires_at: null }, github]);
  assert.equal(withoutExpiry.kind, "Unreadable");
  assert.equal(withoutExpiry.kind === "Unreadable" && withoutExpiry.name, "CLAUDE_CODE_OAUTH_TOKEN");
  assert.match(withoutExpiry.kind === "Unreadable" ? withoutExpiry.detail : "", /expiresAt/);

  const withoutProvider = storedKeys([github, row({ name: "ANTHROPIC_API_KEY", kind: "ApiKey" })]);
  assert.equal(withoutProvider.kind === "Unreadable" && withoutProvider.name, "ANTHROPIC_API_KEY");
  assert.match(withoutProvider.kind === "Unreadable" ? withoutProvider.detail : "", /provider/);
});

const stored = [
  row({ name: "ANTHROPIC_API_KEY", kind: "ApiKey", provider: "Anthropic", sealed: "sealed-key" }),
  row({ name: "GITHUB_TOKEN", kind: "Variable", sealed: "sealed-github" }),
  row({ name: "NPM_TOKEN", kind: "Variable", sealed: "sealed-npm" }),
];

test("a member sent without a value keeps the value stored under its name", () => {
  const plan = planUpdate(stored, [
    { kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic" },
    { kind: "Variable", name: "GITHUB_TOKEN" },
    { kind: "Variable", name: "NPM_TOKEN", value: "npm-new" },
  ]);
  assert.equal(plan.kind, "Planned");
  if (plan.kind !== "Planned") return;
  assert.deepEqual(
    plan.members.map((member) => (member.kind === "Kept" ? member.from.sealed : member.member)),
    ["sealed-key", "sealed-github", { kind: "Variable", name: "NPM_TOKEN", value: "npm-new" }],
  );
  assert.equal(plan.keepsGitHubUser, true);
});

test("a renamed member keeps the value stored under its previous name", () => {
  const plan = planUpdate(stored, [{ kind: "Variable", name: "NODE_AUTH_TOKEN", previousName: "NPM_TOKEN" }]);
  assert.equal(plan.kind, "Planned");
  if (plan.kind !== "Planned") return;
  assert.deepEqual(
    plan.members.map((member) => (member.kind === "Kept" ? [member.update.name, member.from.sealed] : null)),
    [["NODE_AUTH_TOKEN", "sealed-npm"]],
  );
  assert.equal(plan.keepsGitHubUser, false);
});

test("a member left out is the only member the update deletes", () => {
  const plan = planUpdate(stored, [
    { kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic" },
    { kind: "Variable", name: "NPM_TOKEN" },
  ]);
  assert.equal(plan.kind, "Planned");
  if (plan.kind !== "Planned") return;
  assert.deepEqual(
    plan.members.map((member) => (member.kind === "Kept" ? member.from.name : null)),
    ["ANTHROPIC_API_KEY", "NPM_TOKEN"],
  );
  assert.equal(plan.keepsGitHubUser, false);
});

test("a member without a value and nothing stored to keep is refused, as is a value renamed into the GitHub token", () => {
  assert.deepEqual(planUpdate(stored, [{ kind: "Variable", name: "PYPI_TOKEN" }]), {
    kind: "NoStoredValue",
    name: "PYPI_TOKEN",
    source: "PYPI_TOKEN",
  });
  assert.deepEqual(planUpdate(stored, [{ kind: "Variable", name: "GITHUB_TOKEN", previousName: "NPM_TOKEN" }]), {
    kind: "UncheckedToken",
    source: "NPM_TOKEN",
  });
});
