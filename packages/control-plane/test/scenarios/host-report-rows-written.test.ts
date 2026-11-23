import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { World } from "./harness/world.ts";

test("heartbeats whose load, free memory and disk move write no tenant row within 30 s of the stored report, and one after", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  host.quiet();
  const beat = async (step: number): Promise<number> => {
    const before = world.tenantRowsWritten();
    host.report({ ...DEFAULT_USAGE, loadAverage: step / 10, memoryAvailableMib: 30000 - step, diskHeldMib: step });
    await world.settle();
    return world.tenantRowsWritten() - before;
  };
  let written = 0;
  for (let step = 1; step <= 28; step++) {
    await world.passes(1_000);
    written += await beat(step);
  }
  assert.equal(written, 0);

  await world.passes(3_000);
  assert.equal(await beat(31), 1);
});

test("a heartbeat that names every turn and box the host holds writes no tenant row", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  host.quiet();
  await world.startSession({ prompt: "run while the host reports", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  const start = world.tenantRowsWritten();

  for (let beat = 1; beat <= 5; beat++) {
    await world.passes(1_000);
    await host.beats({ heldTurnIds: [offer.turnId], heldSessionIds: [offer.sessionId] });
  }

  assert.equal(world.tenantRowsWritten() - start, 0);
  assert.equal((await world.turn(offer.turnId)).state, "Running");
});
