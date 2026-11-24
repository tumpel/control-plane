import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { TenantApiProtocol } from "@tumpel/schemas";
import { serveTenantRequest, type TenantHandlers, TenantSkew, tenantApi, tenantSkewed } from "../src/tenant-api.ts";

const persona = {
  personaId: "p1",
  tenantId: "t1",
  name: "Reviewer",
  harness: "ClaudeCode",
  secretSetId: "s1",
  connectorIds: [],
  boxRetention: "Off",
  files: [],
  createdAt: 1,
  updatedAt: 1,
} as const;

const handlers = {
  getPersona: ({ personaId }) => ({ persona: personaId === "p1" ? persona : null }),
} as TenantHandlers;

const serve = async (request: unknown) => {
  let resets = 0;
  const response = await serveTenantRequest(request, handlers, () => {
    resets += 1;
  });
  await sleep(1);
  return { response, resets };
};

const getPersona = (tenantApiVersion: number, input: unknown = { tenantId: "t1", personaId: "p1" }) => ({
  tenantApiVersion,
  operation: "getPersona",
  input,
});

test("the tenant durable object serves an operation of its version", async () => {
  assert.deepEqual(await serve(getPersona(TenantApiProtocol.Version)), {
    response: { result: { persona } },
    resets: 0,
  });
});

test("a newer version is refused and resets the stale instance", async () => {
  assert.deepEqual(await serve(getPersona(TenantApiProtocol.Version + 1)), {
    response: {
      refusal: "TenantApiVersionUnsupported",
      oldestTenantApiVersion: TenantApiProtocol.Oldest,
      tenantApiVersion: TenantApiProtocol.Version,
    },
    resets: 1,
  });
});

test("a version below the window is refused and keeps the instance", async () => {
  const { response, resets } = await serve(getPersona(TenantApiProtocol.Oldest - 1));
  assert.equal("refusal" in response && response.refusal, "TenantApiVersionUnsupported");
  assert.equal(resets, 0);
});

test("an unknown operation is refused and resets the stale instance", async () => {
  assert.deepEqual(await serve({ tenantApiVersion: TenantApiProtocol.Version, operation: "listGadgets", input: {} }), {
    response: { refusal: "TenantOperationUnknown", operation: "listGadgets" },
    resets: 1,
  });
});

test("an input that fails its schema is refused as invalid", async () => {
  const { response, resets } = await serve(getPersona(TenantApiProtocol.Version, { tenantId: "t1" }));
  assert.equal("refusal" in response && response.refusal, "TenantRequestInvalid");
  assert.equal(resets, 0);
});

test("v34 rejects a send without a caller before invoking its handler", async () => {
  const { response, resets } = await serve({
    tenantApiVersion: 34,
    operation: "sendTurn",
    input: { tenantId: "t1", sessionId: "s1", send: { prompt: "continue" }, hosts: [], now: 1 },
  });
  assert.equal("refusal" in response && response.refusal, "TenantRequestInvalid");
  assert.equal("operation" in response && response.operation, "sendTurn");
  assert.deepEqual("issues" in response && response.issues, [
    "caller: Invalid input: expected object, received undefined",
  ]);
  assert.equal(resets, 0);
});

test("the client turns a refusal from a stale instance into a retryable skew", async () => {
  const stale = tenantApi(
    { getByName: () => ({ handle: async () => ({ refusal: "TenantOperationUnknown", operation: "getPersona" }) }) },
    "t1",
  );
  await assert.rejects(stale.call("getPersona", { tenantId: "t1", personaId: "p1" }), TenantSkew);
  const answered = await stale
    .call("getPersona", { tenantId: "t1", personaId: "p1" })
    .then(() => assert.fail("a stale instance served the call"), tenantSkewed);
  assert.equal(answered.status, 503);
  assert.equal(answered.headers.get("retry-after"), "30");
  assert.equal((await answered.json()).code, "DeployInProgress");
});
