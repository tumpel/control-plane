import { HarnessCatalogEntrySchema, type HostArchitectureSchema } from "@tumpel/api/schemas";
import type { z } from "zod";

export type HarnessCatalogEntry = z.infer<typeof HarnessCatalogEntrySchema>;
export type HostArchitecture = z.infer<typeof HostArchitectureSchema>;

export const IMAGE_ARCHITECTURES: readonly HostArchitecture[] = ["Amd64"];

export const HARNESS_CATALOG: readonly HarnessCatalogEntry[] = HarnessCatalogEntrySchema.array().parse([
  {
    harness: "ClaudeCode",
    harnessVersion: "2.0.0",
    provider: "Anthropic",
    credentialVariables: [
      { kind: "ApiKey", variable: "ANTHROPIC_API_KEY" },
      { kind: "SubscriptionToken", variable: "CLAUDE_CODE_OAUTH_TOKEN" },
    ],
    personaFilePaths: [".claude/settings.json", ".claude/CLAUDE.md", ".claude.json"],
    installRecipe: "npm:@anthropic-ai/claude-code@2.0.0",
  },
  {
    harness: "Codex",
    harnessVersion: "0.50.0",
    provider: "OpenAi",
    credentialVariables: [{ kind: "ApiKey", variable: "OPENAI_API_KEY" }],
    personaFilePaths: [],
    installRecipe: "npm:@openai/codex@0.50.0",
  },
  {
    harness: "OpenCode",
    harnessVersion: "1.0.0",
    provider: "Anthropic",
    credentialVariables: [{ kind: "ApiKey", variable: "OPENCODE_API_KEY" }],
    personaFilePaths: [".config/opencode/opencode.json", ".config/opencode/AGENTS.md"],
    installRecipe: "npm:opencode-ai@1.0.0",
  },
  {
    harness: "PiDev",
    harnessVersion: "0.10.0",
    provider: "Anthropic",
    credentialVariables: [
      { kind: "ApiKey", variable: "ANTHROPIC_API_KEY" },
      { kind: "SubscriptionToken", variable: "ANTHROPIC_OAUTH_TOKEN" },
    ],
    personaFilePaths: [".pi/agent/settings.json", ".pi/agent/models.json", ".pi/agent/AGENTS.md"],
    installRecipe: "npm:@mariozechner/pi-coding-agent@0.10.0",
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
