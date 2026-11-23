import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import {
  DeviceAuthorizationSchema,
  DeviceSchema,
  DeviceTokenSchema,
  ProblemSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import { World } from "./harness/world.ts";

const PROOF_CLIENT_ID = "0123456789abcdef.access";
const OTHER_COMMON_NAME = "fedcba9876543210.access";

const proofTenantId = (commonName: string): string => {
  const hex = createHash("sha256").update(`tenant:${commonName}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

let world: World;

const start = async (name: string) =>
  DeviceAuthorizationSchema.parse(await (await world.postJson("/v1/device/code", { device_name: name })).json());

before(async () => {
  world = await World.open({ vars: { ACCESS_PROOF_COMMON_NAME: PROOF_CLIENT_ID } });
});

after(() => world.close());

test("the proof's service token approves and denies device codes and is refused where a person is required", async () => {
  const proof = { "cf-access-jwt-assertion": world.access.serviceToken(PROOF_CLIENT_ID) };

  const approvedCode = await start("proof approve");
  const approved = await world.postJson(
    "/v1/device/approve",
    { userCode: approvedCode.user_code, tenantId: proofTenantId(PROOF_CLIENT_ID) },
    proof,
  );
  assert.equal(approved.status, 200);
  const device = DeviceSchema.parse(await approved.json());
  assert.equal(device.tenantId, proofTenantId(PROOF_CLIENT_ID));

  const again = await start("proof approve again");
  const second = DeviceSchema.parse(
    await (
      await world.postJson(
        "/v1/device/approve",
        { userCode: again.user_code, tenantId: proofTenantId(PROOF_CLIENT_ID) },
        proof,
      )
    ).json(),
  );
  assert.deepEqual([second.tenantId, second.principalId], [device.tenantId, device.principalId]);

  const deniedCode = await start("proof deny");
  assert.equal((await world.postJson("/v1/device/deny", { userCode: deniedCode.user_code }, proof)).status, 204);

  const stranger = await start("stranger");
  const other = { "cf-access-jwt-assertion": world.access.serviceToken(OTHER_COMMON_NAME) };
  const refusedOther = await world.postJson(
    "/v1/device/approve",
    { userCode: stranger.user_code, tenantId: proofTenantId(OTHER_COMMON_NAME) },
    other,
  );
  assert.equal(refusedOther.status, 403);
  assert.equal(ProblemSchema.parse(await refusedOther.json()).title, "Unknown service token");

  const signUp = await world.postJson("/v1/tenants", { name: "Proof" }, proof);
  assert.equal(signUp.status, 401);
  assert.match(ProblemSchema.parse(await signUp.json()).detail, /service token signs in only to approve or deny/);

  const page = await world.request(`/device?code=${stranger.user_code}`, { headers: proof });
  assert.equal(page.status, 401);
});

test("tumpel login approves its own code with the proof's service token and whoami names the proof tenant", async () => {
  const proof = { "cf-access-jwt-assertion": world.access.serviceToken(PROOF_CLIENT_ID) };
  const code = await start("proof cli");
  const approved = await world.postJson(
    "/v1/device/approve",
    { userCode: code.user_code, tenantId: proofTenantId(PROOF_CLIENT_ID) },
    proof,
  );
  assert.equal(approved.status, 200);
  await world.passes(code.interval * 1000);
  const granted = await world.postJson("/v1/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: code.device_code,
  });
  assert.equal(granted.status, 200);
  const token = DeviceTokenSchema.parse(await granted.json()).access_token;

  const whoami = await world.request("/v1/whoami", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(whoami.status, 200);
  assert.equal(WhoamiSchema.parse(await whoami.json()).tenant.name, "Tumpel proof");
});
