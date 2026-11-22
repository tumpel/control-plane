import type { D1Database } from "@cloudflare/workers-types/index.ts";
import {
  ControlPlaneLimitsSchema,
  type TenantLimitSchema,
  TenantLimitsProfileSchema,
  type TenantLimitsSchema,
  TenantTierSchema,
  type TenantUsageWindowSchema,
} from "@tumpel/schemas";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { hosts, tenantLimits, tenants } from "./db/central-schema.ts";
import { centralDb } from "./db/client.ts";

export type Limits = z.infer<typeof ControlPlaneLimitsSchema>;
export type TenantLimit = z.infer<typeof TenantLimitSchema>;
export type TenantLimitsProfile = z.infer<typeof TenantLimitsProfileSchema>;
export type TenantLimitsView = z.infer<typeof TenantLimitsSchema>;
export type TenantTier = z.infer<typeof TenantTierSchema>;
export type UsageWindow = z.infer<typeof TenantUsageWindowSchema>;

const ceilingPastBindings = ({ ceiling, readsPerMinute, writesPerMinute }: Limits): string[] => [
  ...(ceiling.writesPerMinute > writesPerMinute
    ? [`ceiling.writesPerMinute ${ceiling.writesPerMinute} is over the TENANT_WRITE_RATE limit ${writesPerMinute}`]
    : []),
  ...ceiling.usage
    .filter(({ measure, window, limit }) => measure === "Requests" && window === "Minute" && limit > readsPerMinute)
    .map(
      ({ limit }) => `the ceiling's Requests per minute ${limit} is over the TENANT_READ_RATE limit ${readsPerMinute}`,
    ),
];

export const limitsOf = (env: { TUMPEL_LIMITS: unknown }): Limits => {
  const parsed = ControlPlaneLimitsSchema.safeParse(env.TUMPEL_LIMITS);
  if (!parsed.success) {
    throw new Error(
      `TUMPEL_LIMITS does not match ControlPlaneLimits in typespec: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "TUMPEL_LIMITS"}: ${issue.message}`).join("; ")}; fix the vars in wrangler.jsonc`,
    );
  }
  const past = ceilingPastBindings(parsed.data);
  if (past.length === 0) return parsed.data;
  throw new Error(
    `TUMPEL_LIMITS has a ceiling the edge rate limiters never let a tenant reach: ${past.join("; ")}; lower the ceiling in wrangler.jsonc`,
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
const TENANT_CALL_DURABLE_OBJECT_REQUESTS = 1;
const USAGE_FLUSH_ALARM_DURABLE_OBJECT_REQUESTS = 1;
const DURABLE_OBJECT_REQUESTS_PER_METERED_CALL =
  TENANT_CALL_DURABLE_OBJECT_REQUESTS + USAGE_FLUSH_ALARM_DURABLE_OBJECT_REQUESTS;
const FREE_BURST_MINUTES = 100;

export const freeLimits = (freeTenantsPerAccount: number): TenantLimit[] => {
  const share = (perDay: number): number =>
    Math.max(1, Math.floor((perDay * FREE_PLAN_HEADROOM) / freeTenantsPerAccount));
  const requestsPerDay = share(
    Math.min(
      CLOUDFLARE_FREE_PLAN.workersRequestsPerDay,
      CLOUDFLARE_FREE_PLAN.durableObjectRequestsPerDay / DURABLE_OBJECT_REQUESTS_PER_METERED_CALL,
    ),
  );
  return [
    { measure: "Requests", window: "Day", limit: requestsPerDay },
    { measure: "Requests", window: "Minute", limit: Math.max(1, Math.ceil(requestsPerDay / FREE_BURST_MINUTES)) },
    { measure: "RowsWritten", window: "Day", limit: share(CLOUDFLARE_FREE_PLAN.rowsWrittenPerDay) },
    { measure: "RowsRead", window: "Day", limit: share(CLOUDFLARE_FREE_PLAN.rowsReadPerDay) },
  ];
};

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

export const configuredProfile = (limits: Limits): TenantLimitsProfile => ({
  writesPerMinute: limits.writesPerMinute,
  hostFramesPerMinute: limits.hostFramesPerMinute,
  usage: limits.configured,
});

export const freeProfile = (limits: Limits): TenantLimitsProfile => ({
  ...configuredProfile(limits),
  usage: freeLimits(limits.freeTenantsPerAccount),
});

export const customProfileOf = (stored: string | null): TenantLimitsProfile | null =>
  stored === null ? null : TenantLimitsProfileSchema.parse(JSON.parse(stored));

export const effectiveLimits = (
  limits: Limits,
  tier: TenantTier,
  custom: TenantLimitsProfile | null,
): TenantLimitsView => {
  if (custom !== null) return { source: "Custom", profile: custom };
  if (tier === "Free") return { source: "Free", profile: freeProfile(limits) };
  return { source: "Configured", profile: configuredProfile(limits) };
};

export type HostLimits = { health: string; hostFramesPerMinute: number };

export const hostLimitsOf = async (db: D1Database, limits: Limits, hostId: string): Promise<HostLimits | null> => {
  const row = await centralDb(db)
    .select({ health: hosts.health, tier: tenants.tier, profile: tenantLimits.profile })
    .from(hosts)
    .innerJoin(tenants, eq(tenants.tenantId, hosts.tenantId))
    .leftJoin(tenantLimits, eq(tenantLimits.tenantId, hosts.tenantId))
    .where(eq(hosts.hostId, hostId))
    .get();
  if (row === undefined) return null;
  const { profile } = effectiveLimits(limits, TenantTierSchema.parse(row.tier), customProfileOf(row.profile));
  return { health: row.health, hostFramesPerMinute: profile.hostFramesPerMinute };
};

const RATES = ["writesPerMinute", "hostFramesPerMinute"] as const;

export const pastBound = (profile: TenantLimitsProfile, bound: TenantLimitsProfile): string[] => [
  ...RATES.filter((rate) => profile[rate] > bound[rate]).map(
    (rate) => `${rate} ${profile[rate]} is over ${bound[rate]}`,
  ),
  ...bound.usage
    .filter(
      (budget) =>
        !profile.usage.some(
          (held) =>
            held.measure === budget.measure &&
            WINDOW_MS[held.window] >= WINDOW_MS[budget.window] &&
            held.limit <= budget.limit,
        ),
    )
    .map((budget) => `usage needs ${budget.measure} per ${budget.window.toLowerCase()} at most ${budget.limit}`),
];

const READ_OPERATION =
  /^(list|get|read)[A-Z]|^(transcriptCursor|connectedAccounts|deferredOffers|runningTurnsByHost|turnMetricDimensions)$/;

export const writes = (operation: string): boolean => !READ_OPERATION.test(operation);
