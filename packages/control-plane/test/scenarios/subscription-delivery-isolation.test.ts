import assert from "node:assert/strict";
import { test } from "node:test";
import { SubscriptionSchema, TenantEventSchema } from "@tumpel/schemas";
import { z } from "zod";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { PRINCIPAL_ID, TENANT_ID, World } from "./harness/world.ts";
import { mcpPersona, startBox } from "./signal-fixtures.ts";

test("a rejected host send preserves refusal signals and lets another Foreman claim its delivery", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const personaId = await mcpPersona(world);
  const firstHost = await world.hostOnline("host-1");
  const first = await startBox(world, firstHost, personaId, "plan the first work", "Warm");
  await firstHost.finishes(first.offer);
  const crew = await startBox(world, firstHost, personaId, "build the work", "Warm");
  await firstHost.finishes(crew.offer);
  firstHost.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib });
  await world.settle();
  const secondHost = await world.hostOnline("host-2");
  const second = await startBox(world, secondHost, personaId, "plan the second work", "Warm");
  await secondHost.finishes(second.offer);

  const subscription = {
    prompt: "Continue the work",
    goal: "Land the work",
    events: ["StartRefused", "CapacityAvailable"],
    crewTags: ["crew:x"],
  };
  const foremen = [
    { host: firstHost, subscription: await world.subscribe(first.session, subscription) },
    { host: secondHost, subscription: await world.subscribe(second.session, subscription) },
  ];
  const [a, b] = foremen.sort((left, right) => left.subscription.sessionId.localeCompare(right.subscription.sessionId));
  assert.ok(a && b);

  const rejected: { turnId: string; previousFailures: number }[] = [];
  const injected = new Error("the injected host channel send failed");
  const channel = world.hostChannel(a.host.hostId);
  const send = channel.send.bind(channel);
  const patched = t.mock.method(channel, "send", (message: Parameters<typeof send>[0]): ReturnType<typeof send> => {
    if (message.type !== "TurnOffer" || message.sessionId !== a.subscription.sessionId) return send(message);
    const { count } = world
      .tenantSql()
      .exec(
        "SELECT delivery_failures_in_a_row AS count FROM subscriptions WHERE subscription_id = ?",
        a.subscription.subscriptionId,
      )
      .one();
    rejected.push({ turnId: message.turnId, previousFailures: z.number().parse(count) });
    return Promise.reject(injected);
  });

  assert.deepEqual(
    world.tenantOperations().recordStartRefusal({
      tenantId: TENANT_ID,
      personaId,
      model: "opus",
      refusal: { code: "PoolExhausted", detail: "The host has no room." },
      caller: { kind: "Person", principalId: PRINCIPAL_ID },
      requestedTags: ["crew:x"],
      now: Date.now(),
    }),
    { kind: "Recorded" },
  );
  const archived = await world.fetch(world.owner, "POST", `/v1/sessions/${crew.session.sessionId}/archive`);
  assert.equal(archived.status, 200, await archived.clone().text());
  patched.mock.restore();

  assert.deepEqual(
    rejected.map(({ previousFailures }) => previousFailures),
    [0, 1, 2],
  );
  assert.equal(new Set(rejected.map(({ turnId }) => turnId)).size, 3);
  assert.equal(a.host.holds("TurnOffer"), false);
  const offered = b.host.takeOffer();
  assert.equal(offered.sessionId, b.subscription.sessionId);
  await b.host.claims(offered);
  assert.equal((await world.turn(offered.turnId)).state, "Running");
  assert.equal((await world.subscription(b.subscription.subscriptionId)).deliveryFailuresInARow, 0);

  for (const { turnId } of rejected) {
    const turn = await world.turn(turnId);
    assert.equal(turn.state, "Failed");
    assert.equal(turn.reason, "Undelivered");
    assert.ok(turn.detail.includes(injected.message));
  }
  const paused = await world.subscription(a.subscription.subscriptionId);
  assert.equal(paused.state, "Paused");
  assert.deepEqual(paused.reason, { kind: "DeliveryFailed", turnId: rejected.at(-1)?.turnId });
  assert.equal(paused.deliveryFailuresInARow, 3);
  assert.equal(paused.cursorEventId, a.subscription.cursorEventId);

  const listed = await world.fetch(
    world.owner,
    "GET",
    "/v1/events?afterEventId=0&event=StartRefused&event=CapacityAvailable",
  );
  assert.equal(listed.status, 200);
  const { events } = z.object({ events: TenantEventSchema.array() }).parse(await listed.json());
  assert.deepEqual(
    events.map(({ event }) => event),
    ["StartRefused", "CapacityAvailable"],
  );
  const signal = events.at(-1);
  assert.equal(signal?.event, "CapacityAvailable");
  assert.equal(signal.code, "PoolExhausted");

  const resumed = await world.fetch(world.owner, "POST", `/v1/subscriptions/${a.subscription.subscriptionId}/resume`);
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.equal(SubscriptionSchema.parse(await resumed.json()).state, "Active");
  const redelivered = a.host.takeOffer();
  assert.equal(redelivered.sessionId, a.subscription.sessionId);
  assert.deepEqual(
    TenantEventSchema.array().parse(
      redelivered.prompt
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line)),
    ),
    events,
  );
  await a.host.claims(redelivered);
  assert.equal((await world.turn(redelivered.turnId)).state, "Running");
  assert.equal((await world.subscription(a.subscription.subscriptionId)).cursorEventId, signal.eventId);
});
