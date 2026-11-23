import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import { BUDGETS, World } from "./harness/world.ts";

test("heartbeats whose load, free memory and disk move write no tenant row within 30 s of the stored report, and one after", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const heardAt = Date.now();
  const beat = (at: number, step: number) =>
    world.call("hostHello", {
      hostId: host.hostId,
      boxCapacity: 8,
      usage: {
        ...BUDGETS,
        boxesWarm: 0,
        loadAverage: step / 10,
        memoryAvailableMib: 30000 - step,
        diskHeldMib: step,
      },
      now: at,
      channelProtocol: ChannelProtocol.Version,
    });
  const start = world.tenantRowsWritten();
  for (let step = 1; step <= 29; step++) await beat(heardAt + step * 1000, step);
  assert.equal(world.tenantRowsWritten() - start, 0);

  await beat(heardAt + 31_000, 31);
  assert.equal(world.tenantRowsWritten() - start, 1);
});
