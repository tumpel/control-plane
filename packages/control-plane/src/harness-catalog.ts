import { HarnessCatalogEntrySchema } from "@tumpel/api/schemas";
import type { z } from "zod";

export type HarnessCatalogEntry = z.infer<typeof HarnessCatalogEntrySchema>;

export const HARNESS_CATALOG: readonly HarnessCatalogEntry[] = HarnessCatalogEntrySchema.array().parse([
  {
    harness: "ClaudeCode",
    harnessVersion: "2.0.0",
    provider: "Anthropic",
    installRecipe: "npm:@anthropic-ai/claude-code@2.0.0",
  },
  { harness: "Codex", harnessVersion: "0.50.0", provider: "OpenAi", installRecipe: "npm:@openai/codex@0.50.0" },
  { harness: "OpenCode", harnessVersion: "1.0.0", provider: "Anthropic", installRecipe: "npm:opencode-ai@1.0.0" },
  {
    harness: "PiDev",
    harnessVersion: "0.10.0",
    provider: "Anthropic",
    installRecipe: "npm:@mariozechner/pi-coding-agent@0.10.0",
  },
]);

export const inCatalog = (harness: string, harnessVersion: string): boolean =>
  HARNESS_CATALOG.some((entry) => entry.harness === harness && entry.harnessVersion === harnessVersion);
