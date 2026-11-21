import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { type Host, TENANT_ID, World } from "./harness/world.ts";

const healthIs = async (world: World, host: Host, health: string, detail: string): Promise<void> => {
  world.db.sql.exec("UPDATE hosts SET health = ? WHERE host_id = ?", health, host.hostId);
  await world.call("hostHealth", { tenantId: TENANT_ID, hostId: host.hostId, health, detail, now: Date.now() });
};

test("a delivery turn that cannot be composed fails Undelivered while the turn queued behind it is delivered", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");

  const foreman = await world.startSession({ prompt: "plan the epic", tags: ["role:foreman"] });
  const subscription = await world.subscribe(foreman, {
    prompt: "hand out the next step of the epic",
    goal: "the epic is merged",
    events: ["TurnFailed"],
    crewTags: ["crew:epic"],
  });
  await world.startSession({ prompt: "build part one", tags: ["crew:epic"] });
  await world.startSession({ prompt: "write the readme", tags: [] });
  const offers = [host.takeOffer(), host.takeOffer(), host.takeOffer()];
  for (const offer of offers) {
    await host.claims(offer);
    await host.finishes(offer);
  }
  const [foremanTurn, crewTurn, helperTurn] = offers;
  assert.equal(foremanTurn?.sessionId, foreman.sessionId);

  const path = `/v1/subscriptions/${subscription.subscriptionId}`;
  const paused = await world.fetch(world.owner, "POST", `${path}/pause`, JSON.stringify({ message: "hold on" }));
  assert.equal(paused.status, 200);
  const sql = world.tenantSql();
  const [stored] = z.array(z.object({ event_id: z.number() })).parse(
    sql
      .exec(
        "INSERT INTO events (payload, created_at) VALUES (?, ?) RETURNING event_id",
        JSON.stringify({
          event: "TurnFailed",
          turnId: crewTurn?.turnId,
          sessionId: crewTurn?.sessionId,
          reason: "NoLongerAReason",
          detail: "the harness reported an error",
        }),
        Date.now(),
      )
      .toArray(),
  );
  assert.ok(stored !== undefined);
  sql.exec(
    "INSERT INTO event_sessions (event_id, session_id, tags) VALUES (?, ?, ?)",
    stored.event_id,
    crewTurn?.sessionId,
    JSON.stringify(["crew:epic"]),
  );

  await healthIs(world, host, "RateLimited", "host sent more than 600 frames a minute");
  await world.sendTurn(helperTurn?.sessionId ?? "", "a turn queued behind the delivery");
  const resumed = await world.fetch(world.owner, "POST", `${path}/resume`);
  assert.equal(resumed.status, 200);
  await healthIs(world, host, "Healthy", "host sent no more than 600 frames a minute for a full minute");

  const deliveries = z
    .array(z.object({ turn_id: z.string() }))
    .parse(
      sql
        .exec("SELECT turn_id FROM turns WHERE session_id = ? AND turn_id != ?", foreman.sessionId, foremanTurn?.turnId)
        .toArray(),
    );
  assert.equal(deliveries.length, 1, "the resume queued one delivery turn");
  const [delivery] = deliveries;
  assert.ok(delivery !== undefined);

  const { handoffs } = z
    .object({ handoffs: z.array(z.object({ offer: z.object({ turnId: z.string(), sessionId: z.string() }) })) })
    .parse(await world.call("deferredOffers", { tenantId: TENANT_ID, hostId: host.hostId }));

  assert.deepEqual(
    handoffs.map((handoff) => handoff.offer.sessionId),
    [helperTurn?.sessionId],
  );
  const failed = await world.turn(delivery.turn_id);
  assert.equal(failed.state, "Failed");
  assert.equal(failed.state === "Failed" ? failed.reason : null, "Undelivered");
  assert.match(
    failed.state === "Failed" ? (failed.detail ?? "") : "",
    new RegExp(`could not be composed.*stored event ${stored.event_id} does not match the event schema`, "s"),
  );
});
