import {
  type EffectiveHarnessVersionSchema,
  HarnessApiSchema,
  HarnessCatalogEntrySchema,
  ProviderSurfaceSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";

export type HarnessCatalogEntry = z.infer<typeof HarnessCatalogEntrySchema>;
export type EffectiveHarnessVersion = z.infer<typeof EffectiveHarnessVersionSchema>;

export type ProviderRoute = HarnessCatalogEntry["providerRoutes"][number];
type HarnessApi = z.infer<typeof HarnessApiSchema>;

export const CLAUDE_CODE_VERSION = "2.1.325";

export const PROVIDER_SURFACES = ProviderSurfaceSchema.array().parse([
  { provider: "OpenRouter", api: "Anthropic", baseUrl: "https://openrouter.ai/api" },
  { provider: "OpenRouter", api: "OpenAi", baseUrl: "https://openrouter.ai/api/v1" },
]);

const ANTHROPIC_API: HarnessApi = HarnessApiSchema.parse({
  api: "Anthropic",
  tokenVariable: "ANTHROPIC_AUTH_TOKEN",
  baseUrlVariable: "ANTHROPIC_BASE_URL",
});

const routesOver = (api: HarnessApi): ProviderRoute[] =>
  PROVIDER_SURFACES.filter((surface) => surface.api === api.api).map((surface) => ({
    provider: surface.provider,
    variables: [
      { source: "Credential", name: api.tokenVariable },
      { source: "Fixed", name: api.baseUrlVariable, value: surface.baseUrl },
    ],
  }));

export const HARNESS_CATALOG: readonly HarnessCatalogEntry[] = HarnessCatalogEntrySchema.array().parse([
  {
    harness: "ClaudeCode",
    harnessVersion: CLAUDE_CODE_VERSION,
    provider: "Anthropic",
    credentialVariables: [
      { kind: "ApiKey", variable: "ANTHROPIC_API_KEY" },
      { kind: "SubscriptionToken", variable: "CLAUDE_CODE_OAUTH_TOKEN" },
    ],
    providerRoutes: routesOver(ANTHROPIC_API),
    personaFilePaths: [".claude/settings.json", ".claude/CLAUDE.md", ".claude.json"],
    installRecipe: `npm:@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`,
  },
  {
    harness: "Codex",
    harnessVersion: "0.50.0",
    provider: "OpenAi",
    credentialVariables: [{ kind: "ApiKey", variable: "OPENAI_API_KEY" }],
    providerRoutes: [],
    personaFilePaths: [],
    installRecipe: "npm:@openai/codex@0.50.0",
  },
  {
    harness: "OpenCode",
    harnessVersion: "1.19.5",
    provider: "OpenRouter",
    credentialVariables: [{ kind: "ApiKey", variable: "OPENROUTER_API_KEY" }],
    providerRoutes: [],
    personaFilePaths: [".config/opencode/opencode.json", ".config/opencode/AGENTS.md"],
    installRecipe: "npm:opencode-ai@1.19.5",
  },
  {
    harness: "PiDev",
    harnessVersion: "1.5.2",
    provider: "Anthropic",
    credentialVariables: [
      { kind: "ApiKey", variable: "ANTHROPIC_API_KEY" },
      { kind: "SubscriptionToken", variable: "ANTHROPIC_OAUTH_TOKEN" },
    ],
    providerRoutes: [],
    personaFilePaths: [".pi/agent/settings.json", ".pi/agent/models.json", ".pi/agent/AGENTS.md"],
    installRecipe: "npm:@earendil-works/pi-coding-agent@1.5.2",
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
