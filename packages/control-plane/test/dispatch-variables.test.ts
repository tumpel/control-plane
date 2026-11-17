import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchVariables, type SecretMember } from "@tumpel/api/credentials";

const claudeCode = {
  credentialChoice: "CatalogOrder" as const,
  credentials: [
    {
      provider: "Anthropic" as const,
      kind: "ApiKey" as const,
      variable: "ANTHROPIC_API_KEY",
      fixed: [],
      arguments: [],
      costBasis: "Billed" as const,
    },
    {
      provider: "Anthropic" as const,
      kind: "SubscriptionToken" as const,
      variable: "CLAUDE_CODE_OAUTH_TOKEN",
      fixed: [],
      arguments: [],
      costBasis: "NotBilled" as const,
    },
    {
      provider: "OpenRouter" as const,
      kind: "ApiKey" as const,
      variable: "ANTHROPIC_AUTH_TOKEN",
      fixed: [{ name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api" }],
      arguments: [],
      costBasis: "Billed" as const,
    },
  ],
};
const codex = {
  credentialChoice: "CatalogOrder" as const,
  credentials: [
    {
      provider: "OpenAi" as const,
      kind: "ApiKey" as const,
      variable: "OPENAI_API_KEY",
      fixed: [],
      arguments: [],
      costBasis: "Billed" as const,
    },
  ],
};
const openCode = {
  credentialChoice: "ModelProvider" as const,
  credentials: [
    {
      provider: "OpenRouter" as const,
      kind: "ApiKey" as const,
      variable: "OPENROUTER_API_KEY",
      fixed: [],
      arguments: [],
      costBasis: "Billed" as const,
    },
    {
      provider: "Anthropic" as const,
      kind: "ApiKey" as const,
      variable: "ANTHROPIC_API_KEY",
      fixed: [],
      arguments: [],
      costBasis: "Billed" as const,
    },
    {
      provider: "OpenAi" as const,
      kind: "ApiKey" as const,
      variable: "OPENAI_API_KEY",
      fixed: [],
      arguments: [],
      costBasis: "Billed" as const,
    },
  ],
};
const MODEL = "claude-sonnet";
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
  assert.deepEqual(dispatchVariables(claudeCode, [apiKey, github], MODEL, NOW), {
    kind: "Ready",
    variables: [
      { name: "ANTHROPIC_API_KEY", value: "sk-ant" },
      { name: "GITHUB_TOKEN", value: "ghp" },
    ],
    arguments: [],
  });
  assert.deepEqual(dispatchVariables(claudeCode, [token("2026-11-15T00:00:00+01:00"), openAi], MODEL, NOW), {
    kind: "Ready",
    variables: [
      { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "oauth-token" },
      { name: "OPENAI", value: "sk-openai" },
    ],
    arguments: [],
  });
  assert.deepEqual(dispatchVariables(codex, [apiKey, openAi], MODEL, NOW), {
    kind: "Ready",
    variables: [
      { name: "OPENAI_API_KEY", value: "sk-openai" },
      { name: "ANTHROPIC", value: "sk-ant" },
    ],
    arguments: [],
  });
});

test("a login file reaches the box as a file at its catalog path, never as a variable, whatever its expiry", () => {
  const signedIn = {
    credentialChoice: "CatalogOrder" as const,
    credentials: [
      {
        provider: "OpenAi" as const,
        kind: "CredentialFile" as const,
        variable: "CODEX_AUTH_JSON",
        path: ".codex/auth.json",
        fixed: [],
        arguments: ["-c", 'cli_auth_credentials_store="file"'],
        costBasis: "NotBilled" as const,
      },
      ...codex.credentials,
    ],
  };
  const file: SecretMember = {
    kind: "CredentialFile",
    name: "CODEX_AUTH_JSON",
    provider: "OpenAi",
    expiresAt: "2026-11-14T11:00:00+00:00",
    value: '{"tokens":{}}',
  };
  assert.deepEqual(dispatchVariables(signedIn, [file, github], MODEL, NOW), {
    kind: "Ready",
    variables: [{ name: "GITHUB_TOKEN", value: "ghp" }],
    arguments: ["-c", 'cli_auth_credentials_store="file"'],
    credentialFile: { path: ".codex/auth.json", value: '{"tokens":{}}' },
  });
});

test("a subscription token at or past its expiry refuses the dispatch by name", () => {
  assert.deepEqual(dispatchVariables(claudeCode, [token("2026-11-14T13:00:00+01:00"), github], MODEL, NOW), {
    kind: "Expired",
    name: "ANTHROPIC",
    expiresAt: "2026-11-14T13:00:00+01:00",
  });
  assert.equal(dispatchVariables(claudeCode, [token("2026-11-14T13:00:01+01:00")], MODEL, NOW).kind, "Ready");
});

test("a set without a credential for the harness's provider has nothing to dispatch", () => {
  assert.deepEqual(dispatchVariables(codex, [apiKey, github], MODEL, NOW), {
    kind: "NoCredential",
    accepted: codex.credentials,
  });
});

test("an ApiKey of a provider serving the harness's API lands in its variables, and the first accepted credential wins", () => {
  const openRouter: SecretMember = { kind: "ApiKey", name: "API_KEY", provider: "OpenRouter", value: "sk-or" };
  const stray: SecretMember = { kind: "Variable", name: "ANTHROPIC_API_KEY", value: "stale" };
  assert.deepEqual(dispatchVariables(claudeCode, [openRouter, stray, github], MODEL, NOW), {
    kind: "Ready",
    variables: [
      { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-or" },
      { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api" },
      { name: "GITHUB_TOKEN", value: "ghp" },
    ],
    arguments: [],
  });
  assert.deepEqual(dispatchVariables(claudeCode, [openRouter, apiKey], MODEL, NOW), {
    kind: "Ready",
    variables: [
      { name: "ANTHROPIC_API_KEY", value: "sk-ant" },
      { name: "API_KEY", value: "sk-or" },
    ],
    arguments: [],
  });
});

test("no other member lands on a variable or fixed variable any accepted credential of the harness uses", () => {
  const openRouter: SecretMember = { kind: "ApiKey", name: "API_KEY", provider: "OpenRouter", value: "sk-or" };
  const strays: SecretMember[] = [
    { kind: "Variable", name: "ANTHROPIC_BASE_URL", value: "https://elsewhere.example" },
    { kind: "Variable", name: "CLAUDE_CODE_OAUTH_TOKEN", value: "stale" },
    { kind: "Variable", name: "ANTHROPIC_AUTH_TOKEN", value: "stale" },
  ];
  assert.deepEqual(dispatchVariables(claudeCode, [...strays, openRouter, github], MODEL, NOW), {
    kind: "Ready",
    variables: [
      { name: "ANTHROPIC_AUTH_TOKEN", value: "sk-or" },
      { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api" },
      { name: "GITHUB_TOKEN", value: "ghp" },
    ],
    arguments: [],
  });
});

test("a harness that speaks several providers takes the credential of the provider the model names", () => {
  const openRouter: SecretMember = { kind: "ApiKey", name: "OPENROUTER", provider: "OpenRouter", value: "sk-or" };
  const held = [openRouter, apiKey, openAi, github];
  const first = (model: string) => {
    const dispatch = dispatchVariables(openCode, held, model, NOW);
    return dispatch.kind === "Ready" ? dispatch.variables[0] : dispatch;
  };
  assert.deepEqual(first("anthropic/claude-sonnet"), { name: "ANTHROPIC_API_KEY", value: "sk-ant" });
  assert.deepEqual(first("openai/gpt-5"), { name: "OPENAI_API_KEY", value: "sk-openai" });
  assert.deepEqual(first("moonshotai/kimi-k2"), { name: "OPENROUTER_API_KEY", value: "sk-or" });
  assert.deepEqual(dispatchVariables(openCode, [apiKey, github], "openai/gpt-5", NOW), {
    kind: "NoModelCredential",
    model: "openai/gpt-5",
    provider: "OpenAi",
    accepted: [openCode.credentials[2]],
  });
});
