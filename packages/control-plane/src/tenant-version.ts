import { problem } from "./http.ts";

export const TENANT_RPC_VERSION = 1;

export class TenantSkew extends Error {}

type Versioned = { rpcVersion(): Promise<number> };

const verified: Set<string> = new Set();

const verify = async (name: string, stub: Versioned): Promise<void> => {
  if (verified.has(name)) return;
  const skew = (runs: string): TenantSkew =>
    new TenantSkew(`tenant ${name} runs Tenant RPC version ${runs} and this Worker expects ${TENANT_RPC_VERSION}`);
  const version = await stub.rpcVersion().catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("does not implement the method")) throw skew("0");
    throw error;
  });
  if (version !== TENANT_RPC_VERSION) throw skew(String(version));
  verified.add(name);
};

export const checkedTenants = <Stub extends Versioned>(namespace: {
  getByName(name: string): Stub;
}): { getByName(name: string): Stub } => ({
  getByName: (name) =>
    new Proxy(namespace.getByName(name), {
      get: (stub, method) => {
        const call: unknown = Reflect.get(stub, method);
        if (typeof call !== "function" || method === "then") return call;
        return async (...args: unknown[]) => {
          await verify(name, stub);
          return Reflect.apply(call, stub, args);
        };
      },
    }),
});

export const tenantSkewed = (error: unknown): Response => {
  if (!(error instanceof TenantSkew)) throw error;
  return problem(
    503,
    {
      code: "DeployInProgress",
      title: "Deploy in progress",
      detail: `a deploy of the control plane is rolling out: ${error.message}`,
      fix: "Retry in a minute, once the deploy has rolled out",
    },
    { "retry-after": "30" },
  );
};
