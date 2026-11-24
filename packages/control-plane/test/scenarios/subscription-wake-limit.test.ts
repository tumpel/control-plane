import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { HostRecordSchema, SendTurnResultSchema, StartSessionResultSchema, TenantEventSchema } from "@tumpel/schemas";
import { CLAUDE_CODE_VERSION } from "../../src/harness-catalog.ts";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { PRINCIPAL_ID, TENANT_ID, type TurnOffer, World } from "./harness/world.ts";
import { mcpPersona, startBox } from "./signal-fixtures.ts";

const fixture = async (t: TestContext) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const personaId = await mcpPersona(world);
  const foreman = await startBox(world, host, personaId, "plan the work", "Warm");
  const subscription = await world.subscribe(foreman.session, {
    prompt: "Continue the work",
    goal: "Land the work",
    events: ["StartRefused", "CapacityAvailable", "TurnCompleted"],
    crewTags: ["crew:x"],
  });
  const count = (): number =>
    Number(
      world
        .tenantSql()
        .exec("SELECT wakes_without_progress FROM subscriptions WHERE subscription_id = ?", subscription.subscriptionId)
        .one().wakes_without_progress,
    );
  const refuse = async (caller: TurnOffer): Promise<void> => {
    const before = world.tenantRowsWritten();
    const wait = world.tenantSql().exec("SELECT COUNT(*) AS count FROM subscription_room_waits").one().count;
    assert.deepEqual(
      await world.call("recordStartRefusal", {
        tenantId: TENANT_ID,
        refusal: { code: "PoolExhausted", detail: "The host has no room." },
        caller: { kind: "Turn", sessionId: caller.sessionId, turnId: caller.turnId },
        personaId,
        model: "opus",
        requestedTags: [],
        now: Date.now(),
      }),
      { kind: "Recorded" },
    );
    assert.equal(world.tenantRowsWritten() - before, wait === 0 ? 12 : 10);
  };
  const claimWake = async (current: TurnOffer): Promise<TurnOffer> => {
    await refuse(current);
    await host.finishes(current);
    const wake = host.takeOffer();
    assert.equal(wake.sessionId, foreman.session.sessionId);
    assert.match(wake.prompt, /"event":"StartRefused"/);
    const before = world.tenantRowsWritten();
    await host.claims(wake);
    assert.equal(world.tenantRowsWritten() - before, 12);
    return wake;
  };
  return { world, host, personaId, foreman, subscription, count, refuse, claimWake };
};

test("F1 runs ten wakes and an ordinary crew delivery, then pauses on the next wake", async (t) => {
  const { world, host, personaId, foreman, subscription, count, refuse, claimWake } = await fixture(t);
  const crew = await startBox(world, host, personaId, "build the work", "Warm", ["crew:x"]);
  host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib });
  await world.settle();

  let current = foreman.offer;
  for (let wake = 1; wake <= 10; wake++) {
    current = await claimWake(current);
    assert.equal(count(), wake);
  }
  await host.finishes(current);
  await host.finishes(crew.offer);
  const ordinary = host.takeOffer();
  assert.equal(ordinary.sessionId, foreman.session.sessionId);
  assert.match(ordinary.prompt, /"event":"TurnCompleted"/);
  assert.doesNotMatch(ordinary.prompt, /"event":"StartRefused"/);
  await host.claims(ordinary);
  assert.equal(count(), 10);
  assert.equal((await world.subscription(subscription.subscriptionId)).state, "Active");

  await refuse(ordinary);
  await host.finishes(ordinary);
  assert.equal(host.holds("TurnOffer"), false);
  const paused = await world.subscription(subscription.subscriptionId);
  assert.equal(paused.state, "Paused");
  assert.deepEqual(paused.reason, { kind: "StartsRefused" });
  assert.equal(count(), 10);
  const listed = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=SubscriptionPaused");
  assert.equal(listed.status, 200);
  const { events } = await listed.json();
  const pauses = TenantEventSchema.array().parse(events);
  assert.equal(pauses.length, 1);
  const [event] = pauses;
  assert.equal(event?.event, "SubscriptionPaused");
  assert.equal(event.subscriptionId, subscription.subscriptionId);
  assert.deepEqual(event.reason, { kind: "StartsRefused" });
  const resumed = await world.fetch(world.owner, "POST", `/v1/subscriptions/${subscription.subscriptionId}/resume`);
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.equal(count(), 0);
  assert.match(host.takeOffer().prompt, /"event":"StartRefused"/);
});

test("successful starts and sends reset the wake count of their Turn caller", async (t) => {
  const { world, host, personaId, foreman, count, claimWake } = await fixture(t);
  const another = await startBox(world, host, personaId, "plan other work", "Warm", ["crew:x"]);
  const wake = await claimWake(foreman.offer);
  assert.equal(count(), 1);

  const read = await world.fetch(world.owner, "GET", `/v1/hosts/${host.hostId}`);
  assert.equal(read.status, 200);
  const hostRecord = HostRecordSchema.parse(await read.json());
  const start = async (caller: TurnOffer) => {
    const now = Date.now();
    const origin = { kind: "Turn", sessionId: caller.sessionId, turnId: caller.turnId };
    const before = world.tenantRowsWritten();
    const { started } = StartSessionResultSchema.parse(
      await world.call("startSession", {
        tenantId: TENANT_ID,
        input: {
          principalId: PRINCIPAL_ID,
          startedBy: origin,
          hosts: [hostRecord],
          harness: "ClaudeCode",
          harnessVersion: CLAUDE_CODE_VERSION,
          endpoint: "https://api.scenario.test",
          start: {
            personaId,
            prompt: "start crew",
            model: "opus",
            repository: foreman.session.repository,
            tags: ["crew:x"],
          },
        },
        now,
      }),
    );
    const delta = world.tenantRowsWritten() - before;
    assert.equal(started.kind, "Started");
    assert.equal(host.takeOffer().sessionId, started.started.session.sessionId);
    return delta;
  };

  const baseline = 26;
  assert.equal(await start(another.offer), baseline);
  assert.equal(count(), 1);
  assert.equal(await start(wake), baseline + 1);
  assert.equal(count(), 0);
  assert.equal(await start(wake), baseline);
  assert.equal(count(), 0);

  const next = await claimWake(wake);
  assert.equal(count(), 1);
  const { sent } = SendTurnResultSchema.parse(
    await world.call("sendTurn", {
      tenantId: TENANT_ID,
      sessionId: another.session.sessionId,
      send: { prompt: "continue the work" },
      hosts: [hostRecord],
      caller: { kind: "Turn", sessionId: next.sessionId, turnId: next.turnId },
      now: Date.now(),
    }),
  );
  assert.equal(sent.kind, "Sent");
  assert.equal(count(), 0);
});
