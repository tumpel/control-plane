import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchVariables, type SecretMember } from "../src/dispatch-variables.ts";

const claudeCode = {
  credentials: [
    { provider: "Anthropic" as const, kind: "ApiKey" as const, variable: "ANTHROPIC_API_KEY", fixed: [] },
    {
      provider: "Anthropic" as const,
      kind: "SubscriptionToken" as const,
      variable: "CLAUDE_CODE_OAUTH_TOKEN",
      fixed: [],
    },
    {
      provider: "OpenRouter" as const,
      kind: "ApiKey" as const,
      variable: "ANTHROPIC_AUTH_TOKEN",
      fixed: [{ name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api" }],
    },
  ],
};
const codex = {
  credentials: [{ provider: "OpenAi" as const, kind: "ApiKey" as const, variable: "OPENAI_API_KEY", fixed: [] }],
};
const NOW = Date.parse("2026-11-14T12:00:00+00:00");

const token = (expiresAt: string): SecretMember => ({
  kind: "SubscriptionToken",
  name: "ANTHROPIC",
  provider: "Anthropic",
  expiresAt,
  value: "oauth-token",
});
const apiKey: SecretMember = { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: "sk-ant" };
const openAi: SecretMember = { kind: "ApiKey", name: "OPENAI", provider: "OpenAi", value: "sk-openai" };
const github: SecretMember = { kind: "Variable", name: "GITHUB_TOKEN", value: "ghp" };

test("the credential's kind picks the variable the harness reads, and every other member keeps its name", () => {
  assert.deepEqual(dispatchVariables(claudeCode, [apiKey, github], NOW), {
    kind: "Ready",
    variables: [
      { name: "ANTHROPIC_API_KEY", value: "sk-ant" },
      { name: "GITHUB_TOKEN", value: "ghp" },
    ],
  });
  assert.deepEqual(dispatchVariables(claudeCode, [token("2026-11-15T00:00:00+01:00"), openAi], NOW), {
    kind: "Ready",
    variables: [
      { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "oauth-token" },
      { name: "OPENAI", value: "sk-openai" },
    ],
  });
  assert.deepEqual(dispatchVariables(codex, [apiKey, openAi], NOW), {
    kind: "Ready",
    variables: [
      { name: "OPENAI_API_KEY", value: "sk-openai" },
      { name: "ANTHROPIC", value: "sk-ant" },
    ],
  });
});

test("a subscription token at or past its expiry refuses the dispatch by name", () => {
  assert.deepEqual(dispatchVariables(claudeCode, [token("2026-11-14T13:00:00+01:00"), github], NOW), {
    kind: "Expired",
    name: "ANTHROPIC",
    expiresAt: "2026-11-14T13:00:00+01:00",
  });
  assert.equal(dispatchVariables(claudeCode, [token("2026-11-14T13:00:01+01:00")], NOW).kind, "Ready");
});

test("a set without a credential for the harness's provider has nothing to dispatch", () => {
  assert.deepEqual(dispatchVariables(codex, [apiKey, github], NOW), {
    kind: "NoCredential",
    accepted: codex.credentials,
  });
});

test("an ApiKey of a provider serving the harness's API lands in its variables, and the first accepted credential wins", () => {
  const openRouter: SecretMember = { kind: "ApiKey", name: "API_KEY", provider: "OpenRouter", value: "sk-or" };
  assert.deepEqual(dispatchVariables(claudeCode, [openRouter, github], NOW), {
    kind: "Ready",
    variables: [
      { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-or" },
      { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api" },
      { name: "GITHUB_TOKEN", value: "ghp" },
    ],
  });
  assert.deepEqual(dispatchVariables(claudeCode, [openRouter, apiKey], NOW), {
    kind: "Ready",
    variables: [
      { name: "ANTHROPIC_API_KEY", value: "sk-ant" },
      { name: "API_KEY", value: "sk-or" },
    ],
  });
});
