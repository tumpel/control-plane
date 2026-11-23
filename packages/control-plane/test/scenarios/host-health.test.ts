import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { World } from "./harness/world.ts";

test("a host the hosts table holds Unhealthy takes no new session, and the refusal names it not healthy", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  world.db.sql.exec("UPDATE hosts SET health = 'Unhealthy' WHERE host_id = ?", host.hostId);

  const started = z
    .object({ started: z.object({ kind: z.literal("Unplaced"), hosts: z.array(z.object({ reason: z.string() })) }) })
    .parse(await world.tryStartSession({ prompt: "start while the host is down", tags: [] }));
  assert.deepEqual(
    started.started.hosts.map((each) => each.reason),
    ["NotHealthy"],
  );
  assert.equal(host.received("TurnOffer").length, 0);
});
