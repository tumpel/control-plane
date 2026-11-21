import {
  ControlPlaneLimitsSchema,
  type TenantLimitSchema,
  type TenantTierSchema,
  type TenantUsageWindowSchema,
} from "@tumpel/schemas";
import type { z } from "zod";

export type Limits = z.infer<typeof ControlPlaneLimitsSchema>;
export type TenantLimit = z.infer<typeof TenantLimitSchema>;
export type TenantTier = z.infer<typeof TenantTierSchema>;
export type UsageWindow = z.infer<typeof TenantUsageWindowSchema>;

export const limitsOf = (env: { TUMPEL_LIMITS: unknown }): Limits => {
  const parsed = ControlPlaneLimitsSchema.safeParse(env.TUMPEL_LIMITS);
  if (parsed.success) return parsed.data;
  throw new Error(
    `TUMPEL_LIMITS does not match ControlPlaneLimits in typespec: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "TUMPEL_LIMITS"}: ${issue.message}`).join("; ")}; fix the vars in wrangler.jsonc`,
  );
};

export const CLOUDFLARE_FREE_PLAN = {
  checkedOn: "2026-11-21",
  sources: [
    "https://developers.cloudflare.com/workers/platform/pricing/ (updated 2026-11-18)",
    "https://developers.cloudflare.com/durable-objects/platform/pricing/ (updated 2026-11-13)",
  ],
  workersRequestsPerDay: 100_000,
  durableObjectRequestsPerDay: 100_000,
  rowsReadPerDay: 5_000_000,
  rowsWrittenPerDay: 100_000,
} as const;

const FREE_PLAN_HEADROOM = 0.8;
const DURABLE_OBJECT_REQUESTS_PER_CALL = 2;
const FREE_BURST_MINUTES = 100;

export const freeLimits = (freeTenantsPerAccount: number): TenantLimit[] => {
  const share = (perDay: number): number =>
    Math.max(1, Math.floor((perDay * FREE_PLAN_HEADROOM) / freeTenantsPerAccount));
  const requestsPerDay = share(
    Math.min(
      CLOUDFLARE_FREE_PLAN.workersRequestsPerDay,
      CLOUDFLARE_FREE_PLAN.durableObjectRequestsPerDay / DURABLE_OBJECT_REQUESTS_PER_CALL,
    ),
  );
  return [
    { measure: "Requests", window: "Day", limit: requestsPerDay },
    { measure: "Requests", window: "Minute", limit: Math.max(1, Math.ceil(requestsPerDay / FREE_BURST_MINUTES)) },
    { measure: "RowsWritten", window: "Day", limit: share(CLOUDFLARE_FREE_PLAN.rowsWrittenPerDay) },
    { measure: "RowsRead", window: "Day", limit: share(CLOUDFLARE_FREE_PLAN.rowsReadPerDay) },
  ];
};

export const tierLimits = (limits: Limits, tier: TenantTier): TenantLimit[] =>
  tier === "Free" ? freeLimits(limits.freeTenantsPerAccount) : limits.configured;

const WINDOW_MS: Record<UsageWindow, number> = { Minute: 60_000, Hour: 3_600_000, Day: 86_400_000 };

export const windowStart = (window: UsageWindow, now: number): number => now - (now % WINDOW_MS[window]);

export const windowEnd = (window: UsageWindow, now: number): number => windowStart(window, now) + WINDOW_MS[window];

export const NEAR_LIMIT_SHARE = 0.8;

export const WEBHOOK_DELIVERIES_PER_MINUTE = 600;

export const MAX_BODY_BYTES = 4_000_000;
export const MAX_CONFIG_BODY_BYTES = 16_000_000;
const MAX_GITHUB_WEBHOOK_BODY_BYTES = 25_000_000;

const BODY_BOUNDS: Record<string, number> = {
  "POST /v1/tenant-config/apply": MAX_CONFIG_BODY_BYTES,
  "POST /v1/tenant-config/plan": MAX_CONFIG_BODY_BYTES,
  "POST /github/webhook": MAX_GITHUB_WEBHOOK_BODY_BYTES,
};

export const bodyBoundOf = (method: string, pathname: string): number =>
  BODY_BOUNDS[`${method} ${pathname}`] ?? MAX_BODY_BYTES;

const READ_OPERATION =
  /^(list|get|read)[A-Z]|^(transcriptCursor|connectedAccounts|deferredOffers|runningTurnsByHost|turnMetricDimensions|waitTurns)$/;

export const writes = (operation: string): boolean => !READ_OPERATION.test(operation);
