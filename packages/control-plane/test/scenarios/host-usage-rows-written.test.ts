import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { World } from "./harness/world.ts";

const UsageSchema = z.object({ usage: z.array(z.object({ hostId: z.string(), loadAverage: z.number() })) });

test("heartbeats inside the usage window write no rows, and placement still reads the latest usage", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const start = world.tenantRowsWritten();
  for (let beat = 1; beat <= 50; beat++) {
    await world.call("hostUsage", {
      hostId: host.hostId,
      usage: { boxesWarm: 0, loadAverage: beat / 10, memoryAvailableMib: 30000 - beat },
      now: Date.now() + beat * 1000,
    });
  }
  assert.equal(world.tenantRowsWritten() - start, 0);
  const { usage } = UsageSchema.parse(await world.call("listHostUsage", { tenantId: "tenant-scenario" }));
  assert.equal(usage.find((each) => each.hostId === host.hostId)?.loadAverage, 5);
});
