import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyMembers, type PlaintextRow } from "../src/legacy-secrets.ts";

const row = (name: string, provider = "Anthropic", secret_set_id = "set-1"): PlaintextRow => ({
  secret_set_id,
  name,
  provider,
  value: `value-of-${name}`,
  updated_at: 1,
});

const shape = (rows: PlaintextRow[]) =>
  legacyMembers(rows)
    .map((member) => [member.row.secret_set_id, member.name, member.kind, member.row.value])
    .sort((a, b) => (`${a[0]}/${a[1]}` < `${b[0]}/${b[1]}` ? -1 : 1));

test("the key named after the old catalog key becomes the provider's credential, and an earlier name stays a variable", () => {
  assert.deepEqual(shape([row("ANTHROPIC_ADMIN_KEY"), row("ANTHROPIC_API_KEY"), row("OPENAI_ORG", "OpenAi")]), [
    ["set-1", "ANTHROPIC_ADMIN_KEY", "Variable", "value-of-ANTHROPIC_ADMIN_KEY"],
    ["set-1", "ANTHROPIC_API_KEY", "ApiKey", "value-of-ANTHROPIC_API_KEY"],
    ["set-1", "OPENAI_ORG", "ApiKey", "value-of-OPENAI_ORG"],
  ]);
  assert.deepEqual(shape([row("ANTHROPIC_ADMIN_KEY", "Anthropic", "set-2"), row("ZED", "Anthropic", "set-2")]), [
    ["set-2", "ANTHROPIC_ADMIN_KEY", "ApiKey", "value-of-ANTHROPIC_ADMIN_KEY"],
    ["set-2", "ZED", "Variable", "value-of-ZED"],
  ]);
});

test("a legacy name outside the secret name pattern is renamed, and dropped when the rename collides or still fails", () => {
  assert.deepEqual(
    shape([row("anthropic-api.key"), row("2nd-token"), row("GITHUB_TOKEN"), row("github-token"), row("ünïcode")]),
    [
      ["set-1", "ANTHROPIC_API_KEY", "ApiKey", "value-of-anthropic-api.key"],
      ["set-1", "GITHUB_TOKEN", "Variable", "value-of-GITHUB_TOKEN"],
      ["set-1", "_2ND_TOKEN", "Variable", "value-of-2nd-token"],
      ["set-1", "_N_CODE", "Variable", "value-of-ünïcode"],
    ],
  );
  assert.deepEqual(shape([row("x".repeat(101))]), []);
});
