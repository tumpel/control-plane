import assert from "node:assert/strict";
import { test } from "node:test";
import { GetTurnFailureResultSchema } from "@tumpel/schemas";
import { World } from "./harness/world.ts";

for (const [name, detail] of [
  ["plain", "the harness ended the turn with an error: Credit balance is too low"],
  [
    "with boot console and API response",
    '[    0.000000] Linux version 6.12\nbox boot console\nthe harness ended the turn with an error: API Error: 400 {"error":{"message":"CREDIT BALANCE IS TOO LOW"}}',
  ],
]) {
  test(`a harness credit error reports CreditExhausted: ${name}`, async (t) => {
    const world = await World.open();
    t.after(() => world.close());
    const host = await world.hostOnline("host-1");
    await world.startSession({ prompt: "run the task", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.says({
      type: "TurnFailed",
      turnId: offer.turnId,
      reason: "HarnessReportedError",
      detail,
      failedAt: new Date().toISOString(),
    });
    const { failure } = GetTurnFailureResultSchema.parse(
      await world.call("getTurnFailure", { tenantId: "tenant-scenario", turnId: offer.turnId }),
    );
    assert.equal(failure?.reason, "CreditExhausted");
    assert.equal(
      failure?.detail,
      "The provider's credit balance is too low. Add credits to the provider account, then send the turn again.",
    );
  });
}

test("other harness errors keep their reason and detail", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "run the task", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  const detail = "the harness ended the turn with an error: model not found";
  await host.says({
    type: "TurnFailed",
    turnId: offer.turnId,
    reason: "HarnessReportedError",
    detail,
    failedAt: new Date().toISOString(),
  });
  const { failure } = GetTurnFailureResultSchema.parse(
    await world.call("getTurnFailure", { tenantId: "tenant-scenario", turnId: offer.turnId }),
  );
  assert.equal(failure?.reason, "HarnessReportedError");
  assert.equal(failure?.detail, detail);
});
