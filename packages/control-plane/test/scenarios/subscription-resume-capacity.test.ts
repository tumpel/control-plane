import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { ProblemSchema, SubscriptionSchema, TenantEventSchema } from "@tumpel/schemas";
import { TENANT_ID, World } from "./harness/world.ts";
import { mcpPersona, startBox } from "./signal-fixtures.ts";

const day = 24 * 60 * 60 * 1000;

const fixture = async (t: TestContext) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const personaId = await mcpPersona(world);
  const foreman = await startBox(world, host, personaId, "plan the work", "Warm");
  const crew = await startBox(world, host, personaId, "build the work", "Warm");
  await host.finishes(crew.offer);
  await world.tick(1);
  const subscribe = async (events: string[]) => {
    const created = await world.fetch(
      world.owner,
      "POST",
      "/v1/subscriptions",
      JSON.stringify({
        sessionId: foreman.session.sessionId,
        prompt: "Continue the work",
        goal: "Land the work",
        events,
        crewTags: ["crew:x"],
        expiresAt: new Date(Date.now() + 8 * day).toISOString(),
      }),
    );
    assert.equal(created.status, 200, await created.clone().text());
    const subscription = SubscriptionSchema.parse(await created.json());
    return `/v1/subscriptions/${subscription.subscriptionId}`;
  };
  const pause = async (path: string): Promise<void> => {
    const paused = await world.fetch(world.owner, "POST", `${path}/pause`, JSON.stringify({ message: "Hold" }));
    assert.equal(paused.status, 200);
    assert.equal(SubscriptionSchema.parse(await paused.json()).state, "Paused");
  };
  const resume = (path: string): Promise<Response> => world.fetch(world.owner, "POST", `${path}/resume`);
  const sql = world.tenantSql();
  const latest = (event: string): number =>
    Number(
      sql
        .exec(
          "SELECT event_id FROM events WHERE json_extract(payload, '$.event') = ? ORDER BY event_id DESC LIMIT 1",
          event,
        )
        .one().event_id,
    );
  const refuse = async (): Promise<number> => {
    assert.deepEqual(
      await world.call("recordStartRefusal", {
        tenantId: TENANT_ID,
        refusal: { code: "PoolExhausted", detail: "The host has no room." },
        caller: { kind: "Turn", sessionId: foreman.session.sessionId, turnId: foreman.offer.turnId },
        personaId,
        model: "opus",
        requestedTags: ["crew:x"],
        now: Date.now(),
      }),
      { kind: "Recorded" },
    );
    return latest("StartRefused");
  };
  const delivery = () => {
    const offer = host.takeOffer();
    assert.equal(offer.sessionId, foreman.session.sessionId);
    const events = TenantEventSchema.array().parse(
      offer.prompt
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line)),
    );
    return { offer, events };
  };
  return { world, host, foreman, crew, subscribe, pause, resume, latest, refuse, delivery };
};

test("a paused Foreman gets one capacity delivery on resume and none on a second resume or claim", async (t) => {
  const { world, host, foreman, crew, subscribe, pause, resume, latest, refuse, delivery } = await fixture(t);
  const path = await subscribe(["CapacityAvailable"]);
  await pause(path);
  await refuse();
  await host.dropsIdleBox(crew.offer);
  await host.finishes(foreman.offer);
  assert.equal(host.holds("TurnOffer"), false);

  const before = world.tenantRowsWritten();
  const resumed = await resume(path);
  assert.equal(resumed.status, 200);
  assert.equal(SubscriptionSchema.parse(await resumed.json()).state, "Active");
  assert.equal(world.tenantRowsWritten() - before, 25);
  const { offer, events } = delivery();
  assert.deepEqual(
    events.map(({ event, eventId }) => [event, eventId]),
    [["CapacityAvailable", latest("CapacityAvailable")]],
  );
  await host.claims(offer);
  const replay = world.tenantRowsWritten();
  assert.equal((await resume(path)).status, 200);
  await host.claims(offer);
  assert.equal(world.tenantRowsWritten() - replay, 0);
  assert.equal(host.holds("TurnOffer"), false);
});

test("resume presents the latest refusal of its code and the capacity signal by exact ID", async (t) => {
  const { host, foreman, crew, subscribe, pause, resume, latest, refuse, delivery } = await fixture(t);
  const path = await subscribe(["StartRefused", "CapacityAvailable"]);
  const first = await refuse();
  await pause(path);
  const second = await refuse();
  assert.ok(second > first);
  await host.dropsIdleBox(crew.offer);
  await host.finishes(foreman.offer);
  assert.equal(host.holds("TurnOffer"), false);
  assert.equal((await resume(path)).status, 200);
  const { events } = delivery();
  assert.deepEqual(
    events.map(({ event, eventId }) => [event, eventId]),
    [
      ["StartRefused", second],
      ["CapacityAvailable", latest("CapacityAvailable")],
    ],
  );
  assert.equal(host.holds("TurnOffer"), false);
});

test("a subscription created after its Foreman's refusal still receives the capacity signal", async (t) => {
  const { host, foreman, crew, subscribe, latest, refuse, delivery } = await fixture(t);
  await refuse();
  await subscribe(["StartRefused", "CapacityAvailable"]);
  await host.dropsIdleBox(crew.offer);
  await host.finishes(foreman.offer);
  const { events } = delivery();
  assert.deepEqual(
    events.map(({ event, eventId }) => [event, eventId]),
    [["CapacityAvailable", latest("CapacityAvailable")]],
  );
  assert.equal(host.holds("TurnOffer"), false);
});

test("resuming with a cursor past retention returns SubscriptionCursorExpired and writes nothing", async (t) => {
  const { world, host, foreman, subscribe, pause, resume, refuse } = await fixture(t);
  const path = await subscribe(["CapacityAvailable"]);
  await pause(path);
  await host.finishes(foreman.offer);
  host.quiet();
  await world.tick(7 * day + 1);
  await refuse();

  const before = world.tenantRowsWritten();
  const expired = await resume(path);
  assert.equal(expired.status, 410);
  assert.equal(ProblemSchema.parse(await expired.json()).code, "SubscriptionCursorExpired");
  assert.equal(world.tenantRowsWritten() - before, 0);
  assert.equal(host.holds("TurnOffer"), false);
});
