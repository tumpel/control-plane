import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { type Host, TENANT_ID, World } from "./harness/world.ts";

const RATE_LIMITED = "host sent more than 600 frames a minute";

const healthIs = async (world: World, host: Host, health: string, detail: string): Promise<void> => {
  world.db.sql.exec("UPDATE hosts SET health = ? WHERE host_id = ?", health, host.hostId);
  world.hibernateHostChannel(host.hostId);
  await world.call("hostHealth", { tenantId: TENANT_ID, hostId: host.hostId, health, detail, now: Date.now() });
};

test("a host going RateLimited has its running turn failed RateLimited with the limit named, cancelled on the host, and a HostHealthChanged event", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  await world.startSession({ prompt: "stream a lot", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);

  await healthIs(world, host, "RateLimited", RATE_LIMITED);

  const turn = await world.turn(offer.turnId);
  assert.equal(turn.state, "Failed");
  assert.equal(turn.state === "Failed" ? turn.reason : null, "RateLimited");
  assert.match(turn.state === "Failed" ? (turn.detail ?? "") : "", /more than 600 frames a minute/);
  assert.equal(host.received("TurnCancel").length, 1);
  assert.ok(world.events(world.owner).includes("HostHealthChanged"));
});

test("a turn sent to a RateLimited host fails RateLimited at once and reaches no host", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "first turn", tags: [] });
  const first = host.takeOffer();
  await host.claims(first);
  await host.finishes(first);
  await healthIs(world, host, "RateLimited", RATE_LIMITED);

  const sent = await world.sendTurn(session.sessionId, "a turn while the host is limited");
  assert.equal(host.received("TurnOffer").length, 0);

  const turn = await world.turn(sent.turnId);
  assert.equal(turn.state === "Failed" ? turn.reason : null, "RateLimited");
});

test("a host held Unhealthy after its third trip takes no new session, and the refusal names it not healthy", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  await healthIs(world, host, "Unhealthy", `${RATE_LIMITED} three times within an hour`);

  const started = z
    .object({ started: z.object({ kind: z.literal("Unplaced"), hosts: z.array(z.object({ reason: z.string() })) }) })
    .parse(await world.tryStartSession({ prompt: "start while the host is down", tags: [] }));
  assert.deepEqual(
    started.started.hosts.map((each) => each.reason),
    ["NotHealthy"],
  );
  assert.equal(host.received("TurnOffer").length, 0);
});
