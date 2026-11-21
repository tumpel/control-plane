import { problem } from "./http";
import { limitsOf, WEBHOOK_DELIVERIES_PER_MINUTE, writes } from "./limits.ts";
import { TenantLimited, type TenantRequest, type TenantResponse, tenantSkewed } from "./tenant-api.ts";

export type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };

type TenantStub = {
  handle(request: TenantRequest): Promise<TenantResponse>;
  handleForTenant(request: TenantRequest): Promise<TenantResponse>;
};
type TenantNamespace = { getByName(name: string): TenantStub };

export type RateLimitedEnv<N extends TenantNamespace> = {
  TENANT: N;
  TENANT_READ_RATE: RateLimit;
  TENANT_WRITE_RATE: RateLimit;
  WEBHOOK_RATE: RateLimit;
  TUMPEL_LIMITS: unknown;
};

const RATE_WINDOW_SECONDS = 60;

export class RateLimited extends Error {}

type Charge = { rate: RateLimit; perMinute: number; what: string };

const meters = new WeakMap<object, (tenantId: string, charge: "Request" | "Write") => Promise<void>>();

export const rateLimited = <N extends TenantNamespace, E extends RateLimitedEnv<N>>(env: E, signed: boolean): E => {
  const limits = limitsOf(env);
  const charges: Record<"Request" | "Write", Charge> = signed
    ? {
        Request: {
          rate: env.WEBHOOK_RATE,
          perMinute: WEBHOOK_DELIVERIES_PER_MINUTE,
          what: "signed webhook deliveries",
        },
        Write: { rate: env.WEBHOOK_RATE, perMinute: WEBHOOK_DELIVERIES_PER_MINUTE, what: "signed webhook deliveries" },
      }
    : {
        Request: { rate: env.TENANT_READ_RATE, perMinute: limits.readsPerMinute, what: "requests" },
        Write: { rate: env.TENANT_WRITE_RATE, perMinute: limits.writesPerMinute, what: "writing requests" },
      };
  const charged = new Map<string, Promise<void>>();
  const charge = (tenantId: string, kind: "Request" | "Write"): Promise<void> => {
    const { rate, perMinute, what } = charges[kind];
    const key = signed ? tenantId : `${kind} ${tenantId}`;
    const held = charged.get(key);
    if (held !== undefined) return held;
    const charging = rate.limit({ key: tenantId }).then(({ success }) => {
      if (success) return;
      throw new RateLimited(`tenant ${tenantId} sent more than ${perMinute} ${what} in a minute`);
    });
    charged.set(key, charging);
    return charging;
  };
  const stubOf = (tenantId: string, stub: TenantStub): TenantStub =>
    new Proxy(stub, {
      get: (target, property) => {
        if (property !== "handle") return Reflect.get(target, property);
        return async (request: TenantRequest) => {
          await charge(tenantId, "Request");
          if (writes(request.operation)) await charge(tenantId, "Write");
          return target.handleForTenant(request);
        };
      },
    });
  const tenants = new Proxy(env.TENANT, {
    get: (target, property) => {
      if (property !== "getByName") return Reflect.get(target, property);
      return (name: string) => stubOf(name, target.getByName(name));
    },
  });
  const limited = { ...env, TENANT: tenants };
  meters.set(limited, charge);
  return limited;
};

export const admitCaller = async (env: object, tenantId: string): Promise<void> => {
  await meters.get(env)?.(tenantId, "Request");
};

const secondsUntil = (at: string): number => Math.max(1, Math.ceil((Date.parse(at) - Date.now()) / 1000));

export const limitRefused = (error: unknown): Response => {
  if (error instanceof RateLimited) {
    return problem(
      429,
      {
        code: "RateLimited",
        title: "Too many requests",
        detail: `${error.message}; nothing of this request was written`,
        fix: `Retry after ${RATE_WINDOW_SECONDS} seconds, and send fewer requests a minute`,
      },
      { "retry-after": String(RATE_WINDOW_SECONDS) },
    );
  }
  if (error instanceof TenantLimited) {
    return problem(
      429,
      {
        code: "UsageLimitReached",
        title: "Usage limit reached",
        detail: `${error.message}; nothing of this request was written`,
        fix: `Retry after ${error.refusal.resetsAt}, or move the tenant to a tier with higher limits`,
      },
      { "retry-after": String(secondsUntil(error.refusal.resetsAt)) },
    );
  }
  return tenantSkewed(error);
};
