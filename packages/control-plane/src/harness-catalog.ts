import { type EffectiveHarnessVersionSchema, HarnessCatalogEntrySchema } from "@tumpel/schemas";
import type { z } from "zod";
import { compactorOf } from "./compact.ts";

export type HarnessCatalogEntry = z.infer<typeof HarnessCatalogEntrySchema>;
export type EffectiveHarnessVersion = z.infer<typeof EffectiveHarnessVersionSchema>;

export const CLAUDE_CODE_VERSION = "2.1.325";
export const CODEX_VERSION = "0.169.0";
const CODEX_SIBLING_BINARY_PATHS = ["codex-code-mode-host", "codex-exec-server"];
const OPENCODE_VERSION = "1.19.5";
const PI_VERSION = "1.5.2";

export const GOAL_TURN_CAP = 20;
export const DELIVERY_GOAL_ROUNDS = 5;

const ANTHROPIC_MODELS = [
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-mythos-5-2",
  "claude-mythos-5-1",
  "claude-mythos-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
];
const CLAUDE_CODE_MODELS = ["opus", "sonnet", "haiku", ...ANTHROPIC_MODELS];
const ANTHROPIC_PROVIDER_MODELS = ANTHROPIC_MODELS.map((model) => `anthropic/${model}`);
const CODEX_CHATGPT_MODELS = [
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

export type GoalFold = { fold: (prompt: string, goal: string, rounds: number) => string; limit: number };

export const GOAL_FOLDS: ReadonlyMap<string, GoalFold> = new Map([
  [
    "ClaudeCode",
    {
      fold: (prompt: string, goal: string, rounds: number): string =>
        `/goal ${prompt}\n\nDone when: ${goal}. Or stop after ${rounds} turns.`,
      limit: 4000,
    },
  ],
]);

const codexProvider = (id: string, settings: Record<string, string | boolean>): string[] => {
  const fields = Object.entries({
    ...settings,
    wire_api: "responses",
    request_max_retries: 0,
    stream_max_retries: 0,
    supports_websockets: false,
  }).map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value) : value}`);
  return ["-c", `model_providers.${id}={${fields.join(",")}}`, "-c", `model_provider=${id}`];
};

export const HARNESS_CATALOG: readonly HarnessCatalogEntry[] = HarnessCatalogEntrySchema.array().parse([
  {
    harness: "ClaudeCode",
    compactTranscript: compactorOf("ClaudeCode") !== null,
    goals: GOAL_FOLDS.has("ClaudeCode"),
    harnessVersion: CLAUDE_CODE_VERSION,
    credentialChoice: "CatalogOrder",
    credentials: [
      {
        provider: "Anthropic",
        kind: "ApiKey",
        variable: "ANTHROPIC_API_KEY",
        fixed: [],
        arguments: [],
        costBasis: "Billed",
        modelSupport: { kind: "Listed", models: CLAUDE_CODE_MODELS },
      },
      {
        provider: "Anthropic",
        kind: "SubscriptionToken",
        variable: "CLAUDE_CODE_OAUTH_TOKEN",
        fixed: [],
        arguments: [],
        costBasis: "NotBilled",
        modelSupport: { kind: "Listed", models: CLAUDE_CODE_MODELS },
      },
      {
        provider: "OpenRouter",
        kind: "ApiKey",
        variable: "ANTHROPIC_AUTH_TOKEN",
        fixed: [{ name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api" }],
        arguments: [],
        costBasis: "NotReported",
        modelSupport: { kind: "ProviderChecked" },
      },
    ],
    personaFilePaths: [".claude/settings.json", ".claude/CLAUDE.md", ".claude.json"],
    installRecipe: { kind: "Npm", package: "@anthropic-ai/claude-code", packageVersion: CLAUDE_CODE_VERSION },
  },
  {
    harness: "Codex",
    compactTranscript: compactorOf("Codex") !== null,
    goals: GOAL_FOLDS.has("Codex"),
    harnessVersion: CODEX_VERSION,
    credentialChoice: "CatalogOrder",
    credentials: [
      {
        provider: "OpenAi",
        kind: "CredentialFile",
        variable: "CODEX_AUTH_JSON",
        path: ".codex/auth.json",
        fixed: [],
        arguments: ["-c", `cli_auth_credentials_store="file"`, "-c", `forced_login_method="chatgpt"`],
        costBasis: "NotReported",
        modelSupport: { kind: "Listed", models: CODEX_CHATGPT_MODELS },
      },
      {
        provider: "OpenAi",
        kind: "ApiKey",
        variable: "OPENAI_API_KEY",
        fixed: [],
        arguments: codexProvider("openai-api", {
          name: "OpenAI",
          base_url: "https://api.openai.com/v1",
          env_key: "OPENAI_API_KEY",
        }),
        costBasis: "NotReported",
        modelSupport: { kind: "ProviderChecked" },
      },
      {
        provider: "OpenRouter",
        kind: "ApiKey",
        variable: "OPENROUTER_API_KEY",
        fixed: [],
        arguments: codexProvider("openrouter", {
          name: "OpenRouter",
          base_url: "https://openrouter.ai/api/v1",
          env_key: "OPENROUTER_API_KEY",
        }),
        costBasis: "NotReported",
        modelSupport: { kind: "ProviderChecked" },
      },
    ],
    personaFilePaths: [".codex/config.toml", ".codex/AGENTS.md"],
    installRecipe: {
      kind: "Archive",
      archives: [
        {
          architecture: "Amd64",
          url: `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-package-x86_64-unknown-linux-musl.tar.gz`,
          sha256: "3b8ed091149cc63a59046b9f094bcfa21cdb4dda15ede441ce369bcee4a71ba0",
          binaryPath: "codex",
          siblingBinaryPaths: CODEX_SIBLING_BINARY_PATHS,
        },
        {
          architecture: "Arm64",
          url: `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-package-aarch64-unknown-linux-musl.tar.gz`,
          sha256: "c8d0b4ab2a97c595b70b10412d36d0d5464dcef1e1d3246b073d48017cdf5a4f",
          binaryPath: "codex",
          siblingBinaryPaths: CODEX_SIBLING_BINARY_PATHS,
        },
      ],
      stripComponents: 1,
    },
  },
  {
    harness: "OpenCode",
    compactTranscript: compactorOf("OpenCode") !== null,
    goals: GOAL_FOLDS.has("OpenCode"),
    harnessVersion: OPENCODE_VERSION,
    credentialChoice: "ModelProvider",
    credentials: [
      {
        provider: "OpenRouter",
        kind: "ApiKey",
        variable: "OPENROUTER_API_KEY",
        fixed: [],
        arguments: [],
        costBasis: "Billed",
        modelSupport: { kind: "ProviderChecked" },
      },
      {
        provider: "Anthropic",
        kind: "ApiKey",
        variable: "ANTHROPIC_API_KEY",
        fixed: [],
        arguments: [],
        costBasis: "Billed",
        modelSupport: { kind: "Listed", models: ANTHROPIC_PROVIDER_MODELS },
      },
      {
        provider: "OpenAi",
        kind: "ApiKey",
        variable: "OPENAI_API_KEY",
        fixed: [],
        arguments: [],
        costBasis: "Billed",
        modelSupport: { kind: "ProviderChecked" },
      },
    ],
    personaFilePaths: [".config/opencode/opencode.json", ".config/opencode/AGENTS.md"],
    installRecipe: {
      kind: "Archive",
      archives: [
        {
          architecture: "Amd64",
          url: `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64.tar.gz`,
          sha256: "588310a336fa3b9df36b3f0225b26f679d453efaad0cf3d66c3651ef3ec1647a",
          binaryPath: "opencode",
          siblingBinaryPaths: [],
        },
        {
          architecture: "Arm64",
          url: `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-arm64.tar.gz`,
          sha256: "fae5be262d693b7c5e562856cc473e59e741772936db0c0600ac0d5ed5bd088b",
          binaryPath: "opencode",
          siblingBinaryPaths: [],
        },
      ],
      stripComponents: 0,
    },
  },
  {
    harness: "PiDev",
    compactTranscript: compactorOf("PiDev") !== null,
    goals: GOAL_FOLDS.has("PiDev"),
    harnessVersion: PI_VERSION,
    credentialChoice: "ModelProvider",
    credentials: [
      {
        provider: "Anthropic",
        kind: "ApiKey",
        variable: "ANTHROPIC_API_KEY",
        fixed: [],
        arguments: [],
        costBasis: "Billed",
        modelSupport: { kind: "Listed", models: ANTHROPIC_PROVIDER_MODELS },
      },
      {
        provider: "Anthropic",
        kind: "SubscriptionToken",
        variable: "ANTHROPIC_OAUTH_TOKEN",
        fixed: [],
        arguments: [],
        costBasis: "NotBilled",
        modelSupport: { kind: "Listed", models: ANTHROPIC_PROVIDER_MODELS },
      },
      {
        provider: "OpenRouter",
        kind: "ApiKey",
        variable: "OPENROUTER_API_KEY",
        fixed: [],
        arguments: [],
        costBasis: "Billed",
        modelSupport: { kind: "ProviderChecked" },
      },
    ],
    personaFilePaths: [".pi/agent/settings.json", ".pi/agent/models.json", ".pi/agent/AGENTS.md"],
    installRecipe: {
      kind: "Archive",
      archives: [
        {
          architecture: "Amd64",
          url: `https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/pi-linux-x64.tar.gz`,
          sha256: "811c6f2c9e7aaee252b5404252e556fb713aa209c1f7f924226aa77d4ef70cb5",
          binaryPath: "pi",
          siblingBinaryPaths: [],
        },
        {
          architecture: "Arm64",
          url: `https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/pi-linux-arm64.tar.gz`,
          sha256: "42805cd5615952fcbbfc9c56b04f8feb84395134952e169a6cdc8d7676975666",
          binaryPath: "pi",
          siblingBinaryPaths: [],
        },
      ],
      stripComponents: 1,
    },
  },
]);

export const catalogEntry = (harness: string, harnessVersion: string): HarnessCatalogEntry | undefined =>
  HARNESS_CATALOG.find((entry) => entry.harness === harness && entry.harnessVersion === harnessVersion);

export const inCatalog = (harness: string, harnessVersion: string): boolean =>
  catalogEntry(harness, harnessVersion) !== undefined;

export const defaultEntry = (harness: string): HarnessCatalogEntry | undefined =>
  HARNESS_CATALOG.find((entry) => entry.harness === harness);

export const pinnedEntry = (
  pins: readonly { harness: string; harnessVersion: string }[],
  harness: string,
): HarnessCatalogEntry | undefined => {
  const pinned = pins.find((pin) => pin.harness === harness);
  return pinned === undefined ? defaultEntry(harness) : catalogEntry(harness, pinned.harnessVersion);
};

export const effectiveVersions = (
  pins: readonly { harness: string; harnessVersion: string }[],
): EffectiveHarnessVersion[] =>
  HARNESS_CATALOG.filter((entry) => defaultEntry(entry.harness) === entry).map((entry) => {
    const pinned = pins.find((pin) => pin.harness === entry.harness);
    return pinned === undefined
      ? { harness: entry.harness, harnessVersion: entry.harnessVersion, pinned: false }
      : { harness: entry.harness, harnessVersion: pinned.harnessVersion, pinned: true };
  });
