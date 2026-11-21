import { problem } from "./http";
import { limitsOf } from "./limits.ts";
import { TenantLimited, type TenantRequest, type TenantResponse, tenantSkewed } from "./tenant-api.ts";

export type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };

type TenantStub = { handle(request: TenantRequest): Promise<TenantResponse> };
type TenantNamespace = { getByName(name: string): TenantStub };

export type RateLimitedEnv<N extends TenantNamespace> = {
  TENANT: N;
  TENANT_READ_RATE: RateLimit;
  TENANT_WRITE_RATE: RateLimit;
  TUMPEL_LIMITS: unknown;
};

const RATE_WINDOW_SECONDS = 60;

export class RateLimited extends Error {}

const reads = (method: string): boolean => method === "GET" || method === "HEAD";

export const rateLimited = <N extends TenantNamespace, E extends RateLimitedEnv<N>>(env: E, method: string): E => {
  const reading = reads(method);
  const charged = new Map<string, Promise<void>>();
  const charge = (tenantId: string): Promise<void> => {
    const held = charged.get(tenantId);
    if (held !== undefined) return held;
    const limits = limitsOf(env);
    const rate = reading ? env.TENANT_READ_RATE : env.TENANT_WRITE_RATE;
    const perMinute = reading ? limits.readsPerMinute : limits.writesPerMinute;
    const charging = rate.limit({ key: tenantId }).then(({ success }) => {
      if (success) return;
      throw new RateLimited(
        `tenant ${tenantId} sent more than ${perMinute} ${reading ? "reading" : "writing"} requests in a minute`,
      );
    });
    charged.set(tenantId, charging);
    return charging;
  };
  const stubOf = (tenantId: string, stub: TenantStub): TenantStub =>
    new Proxy(stub, {
      get: (target, property) => {
        if (property !== "handle") return Reflect.get(target, property);
        return async (request: TenantRequest) => {
          await charge(tenantId);
          return target.handle(request);
        };
      },
    });
  const tenants = new Proxy(env.TENANT, {
    get: (target, property) => {
      if (property !== "getByName") return Reflect.get(target, property);
      return (name: string) => stubOf(name, target.getByName(name));
    },
  });
  return { ...env, TENANT: tenants };
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
