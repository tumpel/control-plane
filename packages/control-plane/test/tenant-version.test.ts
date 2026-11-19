import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedTenants, TENANT_RPC_VERSION, tenantSkewed } from "../src/tenant-version.ts";

test("a handler answers 503 while the tenant durable object runs the previous code, then calls through", async () => {
  const calls: string[] = [];
  let running = "previous";
  const tenants = checkedTenants({
    getByName: (name: string) => ({
      rpcVersion: async (): Promise<number> => {
        if (running === "previous") throw new TypeError('The RPC receiver does not implement the method "rpcVersion".');
        return TENANT_RPC_VERSION;
      },
      getPersona: async (personaId: string) => {
        calls.push(`${name}/${personaId}`);
        return { personaId, connectorIds: [] };
      },
    }),
  });

  const skewed = await tenants
    .getByName("t1")
    .getPersona("p1")
    .then(() => assert.fail("the call reached a durable object running the previous code"), tenantSkewed);
  assert.equal(skewed.status, 503);
  assert.equal(skewed.headers.get("retry-after"), "30");
  assert.equal((await skewed.json()).code, "DeployInProgress");
  assert.deepEqual(calls, []);

  running = "current";
  assert.deepEqual(await tenants.getByName("t1").getPersona("p1"), { personaId: "p1", connectorIds: [] });
  assert.deepEqual(calls, ["t1/p1"]);
});
