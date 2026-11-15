import { ControlPlaneSettingsSchema } from "@tumpel/api/schemas";
import type { z } from "zod";

export type Settings = z.infer<typeof ControlPlaneSettingsSchema>;

export const settingsOf = (env: { TUMPEL_SETTINGS: unknown }): Settings => {
  const parsed = ControlPlaneSettingsSchema.safeParse(env.TUMPEL_SETTINGS);
  if (parsed.success) return parsed.data;
  throw new Error(
    `TUMPEL_SETTINGS does not match ControlPlaneSettings in packages/api: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "TUMPEL_SETTINGS"}: ${issue.message}`).join("; ")}; fix the vars in wrangler.jsonc`,
  );
};

export const apiOriginOf = (env: { API_ORIGIN: string }): string => {
  if (env.API_ORIGIN) return env.API_ORIGIN;
  throw new Error(
    "API_ORIGIN is not set; deploy with npm run deploy, which sets it to https:// plus the tofu output hostname, or pass --var API_ORIGIN:https://<api hostname> to wrangler",
  );
};

export const turnCredentialSeconds = (settings: Settings): number =>
  Math.max(settings.dispatchGrantTtlSeconds, settings.turnClaimBudgetSeconds + settings.turnImageFetchBudgetSeconds);
