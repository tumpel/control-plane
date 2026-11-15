import { type EffectiveHarnessVersionSchema, HarnessCatalogEntrySchema } from "@tumpel/api/schemas";
import type { z } from "zod";

export type HarnessCatalogEntry = z.infer<typeof HarnessCatalogEntrySchema>;
export type EffectiveHarnessVersion = z.infer<typeof EffectiveHarnessVersionSchema>;

export const CLAUDE_CODE_VERSION = "2.1.325";
const CODEX_VERSION = "0.50.0";
const OPENCODE_VERSION = "1.19.5";
const PI_VERSION = "1.5.2";

const archiveRecipe = (url: (nodeArch: string) => string, digests: { amd64: string; arm64: string }): string =>
  [`archive:amd64:${url("x64")}#sha256=${digests.amd64}`, `archive:arm64:${url("arm64")}#sha256=${digests.arm64}`].join(
    " ",
  );

export const HARNESS_CATALOG: readonly HarnessCatalogEntry[] = HarnessCatalogEntrySchema.array().parse([
  {
    harness: "ClaudeCode",
    harnessVersion: CLAUDE_CODE_VERSION,
    credentials: [
      { provider: "Anthropic", kind: "ApiKey", variable: "ANTHROPIC_API_KEY", fixed: [] },
      { provider: "Anthropic", kind: "SubscriptionToken", variable: "CLAUDE_CODE_OAUTH_TOKEN", fixed: [] },
      {
        provider: "OpenRouter",
        kind: "ApiKey",
        variable: "ANTHROPIC_AUTH_TOKEN",
        fixed: [{ name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api" }],
      },
    ],
    personaFilePaths: [".claude/settings.json", ".claude/CLAUDE.md", ".claude.json"],
    installRecipe: `npm:@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`,
  },
  {
    harness: "Codex",
    harnessVersion: CODEX_VERSION,
    credentials: [
      { provider: "OpenAi", kind: "ApiKey", variable: "OPENAI_API_KEY", fixed: [] },
      {
        provider: "OpenRouter",
        kind: "ApiKey",
        variable: "OPENAI_API_KEY",
        fixed: [{ name: "OPENAI_BASE_URL", value: "https://openrouter.ai/api/v1" }],
      },
    ],
    personaFilePaths: [],
    installRecipe: `npm:@openai/codex@${CODEX_VERSION}`,
  },
  {
    harness: "OpenCode",
    harnessVersion: OPENCODE_VERSION,
    credentials: [
      { provider: "OpenRouter", kind: "ApiKey", variable: "OPENROUTER_API_KEY", fixed: [] },
      { provider: "Anthropic", kind: "ApiKey", variable: "ANTHROPIC_API_KEY", fixed: [] },
      { provider: "OpenAi", kind: "ApiKey", variable: "OPENAI_API_KEY", fixed: [] },
    ],
    personaFilePaths: [".config/opencode/opencode.json", ".config/opencode/AGENTS.md"],
    installRecipe: archiveRecipe(
      (nodeArch) =>
        `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${nodeArch}.tar.gz`,
      {
        amd64: "588310a336fa3b9df36b3f0225b26f679d453efaad0cf3d66c3651ef3ec1647a",
        arm64: "fae5be262d693b7c5e562856cc473e59e741772936db0c0600ac0d5ed5bd088b",
      },
    ),
  },
  {
    harness: "PiDev",
    harnessVersion: PI_VERSION,
    credentials: [
      { provider: "Anthropic", kind: "ApiKey", variable: "ANTHROPIC_API_KEY", fixed: [] },
      { provider: "Anthropic", kind: "SubscriptionToken", variable: "ANTHROPIC_OAUTH_TOKEN", fixed: [] },
      { provider: "OpenRouter", kind: "ApiKey", variable: "OPENROUTER_API_KEY", fixed: [] },
    ],
    personaFilePaths: [".pi/agent/settings.json", ".pi/agent/models.json", ".pi/agent/AGENTS.md"],
    installRecipe: archiveRecipe(
      (nodeArch) => `https://github.com/earendil-works/pi/releases/download/v${PI_VERSION}/pi-linux-${nodeArch}.tar.gz`,
      {
        amd64: "811c6f2c9e7aaee252b5404252e556fb713aa209c1f7f924226aa77d4ef70cb5",
        arm64: "42805cd5615952fcbbfc9c56b04f8feb84395134952e169a6cdc8d7676975666",
      },
    ),
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
