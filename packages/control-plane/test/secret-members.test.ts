import assert from "node:assert/strict";
import { test } from "node:test";
import { type MemberRow, storedKeys } from "../src/secret-members.ts";

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
