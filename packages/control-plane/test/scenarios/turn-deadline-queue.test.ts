import assert from "node:assert/strict";
import { test } from "node:test";
import { SETTINGS, World } from "./harness/world.ts";

const TOTAL_BUDGET_MS = SETTINGS.turnTotalBudgetSeconds * 1000;

const turnRow = (world: World, turnId: string): Record<string, unknown> | undefined =>
  world.tenantSql().exec("SELECT state, reason FROM turns WHERE turn_id = ?", turnId).toArray()[0];

test("a running turn past its total budget is failed by the deadline message, and a finished turn is left alone", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");

  await world.startSession({ prompt: "never finishes", tags: [] });
  const hung = host.takeOffer();
  await host.claims(hung);
  await world.startSession({ prompt: "finishes", tags: [] });
  const done = host.takeOffer();
  await host.claims(done);
  await host.finishes(done);

  await world.passes(TOTAL_BUDGET_MS - 1000);
  assert.equal(turnRow(world, hung.turnId)?.state, "Running", "the budget has not run out yet");

  await world.passes(2000);
  assert.deepEqual(turnRow(world, hung.turnId), { state: "Failed", reason: "TurnTimedOut" });
  assert.equal(turnRow(world, done.turnId)?.state, "Completed");
});
