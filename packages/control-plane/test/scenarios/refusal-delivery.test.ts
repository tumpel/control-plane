import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { PRINCIPAL_ID, TENANT_ID, World } from "./harness/world.ts";
import { mcpPersona, startBox } from "./signal-fixtures.ts";

const foremanBusyOnFullHost = async (t: TestContext) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const persona = await mcpPersona(world);
  const { session: foreman, offer: foremanTurn } = await startBox(world, host, persona, "plan the work", "Warm", [
    "crew:y",
  ]);
  const subscription = await world.subscribe(foreman, {
    prompt: "Continue the work",
    goal: "Land the work",
    events: ["StartRefused", "CapacityAvailable", "TurnCompleted"],
    crewTags: ["crew:x"],
  });
  host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib });
  await world.settle();
  return { world, host, foreman, foremanTurn, subscription };
};

test("a busy Foreman queues one delivery on a refusal and writes only the event and its count on repeats", async (t) => {
  const { world, host, foreman, foremanTurn, subscription } = await foremanBusyOnFullHost(t);
  const sql = world.tenantSql();
  const deliveries = (subscriptionId: string): number =>
    Number(
      sql.exec("SELECT COUNT(*) AS count FROM subscription_turns WHERE subscription_id = ?", subscriptionId).one()
        .count,
    );
  const events = (): number => Number(sql.exec("SELECT COUNT(*) AS count FROM events").one().count);
  const caller = { kind: "Turn", sessionId: foreman.sessionId, turnId: foremanTurn.turnId };
  const input = {
    tenantId: TENANT_ID,
    refusal: { code: "PoolExhausted", detail: "The host has no room." },
    caller,
    personaId: foreman.personaId,
    model: foreman.model,
    requestedTags: [],
    now: Date.now(),
  };
  const initialRows = events();
  const initialMeter = world.tenantRowsWritten();
  assert.deepEqual(await world.call("recordStartRefusal", input), { kind: "Recorded" });
  assert.equal(world.tenantRowsWritten() - initialMeter, 13);
  assert.equal(events() - initialRows, 1);
  assert.equal(deliveries(subscription.subscriptionId), 1);
  assert.equal(host.holds("TurnOffer"), false);

  for (let repeat = 1; repeat <= 5; repeat++) {
    const before = world.tenantRowsWritten();
    const rows = events();
    assert.deepEqual(await world.call("recordStartRefusal", input), { kind: "Recorded" });
    assert.equal(world.tenantRowsWritten() - before, 3);
    assert.equal(events() - rows, 1);
    assert.equal(deliveries(subscription.subscriptionId), 1);
  }
  const beforePerson = world.tenantRowsWritten();
  const personRows = events();
  assert.deepEqual(
    await world.call("recordStartRefusal", {
      ...input,
      caller: { kind: "Person", principalId: PRINCIPAL_ID },
      requestedTags: ["crew:x"],
    }),
    { kind: "Recorded" },
  );
  assert.equal(world.tenantRowsWritten() - beforePerson, 3);
  assert.equal(events() - personRows, 1);
  assert.equal(deliveries(subscription.subscriptionId), 1);
  const refusalId = sql.exec("SELECT MAX(event_id) AS id FROM events").one().id;

  const ordinaryClaim = sql
    .exec("SELECT start_refusals_in_a_row FROM subscriptions WHERE subscription_id = ?", subscription.subscriptionId)
    .one();
  assert.equal(ordinaryClaim.start_refusals_in_a_row, 7);
  await host.finishes(foremanTurn);
  const first = host.takeOffer();
  assert.equal(first.sessionId, foreman.sessionId);
  assert.match(first.prompt, /"code":"PoolExhausted"/);
  const cursorAfterCompose = (await world.subscription(subscription.subscriptionId)).cursorEventId;
  assert.equal(cursorAfterCompose, subscription.cursorEventId);

  await host.says({
    type: "TurnFailed",
    turnId: first.turnId,
    reason: "Undelivered",
    detail: "The host refused the offer.",
    failedAt: new Date(Date.now()).toISOString(),
  });
  const retried = host.takeOffer();
  assert.equal(retried.sessionId, foreman.sessionId);
  assert.notEqual(retried.turnId, first.turnId);
  assert.equal(retried.prompt, first.prompt);
  assert.equal((await world.subscription(subscription.subscriptionId)).cursorEventId, cursorAfterCompose);

  const state = () =>
    sql
      .exec(
        "SELECT cursor_event_id, start_refusals_in_a_row FROM subscriptions WHERE subscription_id = ?",
        subscription.subscriptionId,
      )
      .one();
  const claimBefore = world.tenantRowsWritten();
  await host.claims(retried);
  const claimDelta = world.tenantRowsWritten() - claimBefore;
  assert.deepEqual({ ...state() }, { cursor_event_id: refusalId, start_refusals_in_a_row: 7 });

  await host.says({
    type: "TurnFailed",
    turnId: retried.turnId,
    reason: "NotClaimed",
    detail: "The host lost the claim reply.",
    failedAt: new Date(Date.now()).toISOString(),
  });
  assert.equal((await world.turn(retried.turnId)).state, "Offered");
  const repeatBefore = world.tenantRowsWritten();
  await host.claims(retried);
  const repeatDelta = world.tenantRowsWritten() - repeatBefore;
  assert.deepEqual({ ...state() }, { cursor_event_id: refusalId, start_refusals_in_a_row: 7 });
  assert.equal(claimDelta, 10);
  assert.equal(repeatDelta, 9);
});

test("refusal routing uses refused tags and an unmatched refusal counts nothing", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const persona = await mcpPersona(world);
  const foreman = await startBox(world, host, persona, "plan the work", "Warm");
  await host.finishes(foreman.offer);
  const subscription = await world.subscribe(foreman.session, {
    prompt: "Continue the work",
    goal: "Land the work",
    events: ["StartRefused", "TurnCompleted"],
    crewTags: ["crew:y"],
  });
  const caller = await startBox(world, host, persona, "build some work", "Warm", ["crew:y"]);
  const sql = world.tenantSql();
  const before = world.tenantRowsWritten();
  assert.deepEqual(
    await world.call("recordStartRefusal", {
      tenantId: TENANT_ID,
      refusal: { code: "ModelUnsupported", detail: "The model is unavailable." },
      caller: { kind: "Turn", sessionId: caller.session.sessionId, turnId: caller.offer.turnId },
      personaId: persona,
      model: "unsupported",
      requestedTags: ["crew:x"],
      now: Date.now(),
    }),
    { kind: "Recorded" },
  );
  assert.equal(world.tenantRowsWritten() - before, 2);
  assert.equal(sql.exec("SELECT COUNT(*) AS count FROM subscription_turns").one().count, 0);
  assert.equal(host.holds("TurnOffer"), false);

  await host.finishes(caller.offer);
  const ordinary = host.takeOffer();
  assert.equal(ordinary.sessionId, foreman.session.sessionId);
  assert.match(ordinary.prompt, /"event":"TurnCompleted"/);
  assert.doesNotMatch(ordinary.prompt, /StartRefused/);
  const eventId = sql
    .exec(
      "SELECT event_id FROM events WHERE json_extract(payload, '$.event') = 'TurnCompleted' ORDER BY event_id DESC LIMIT 1",
    )
    .one().event_id;
  const claimBefore = world.tenantRowsWritten();
  await host.claims(ordinary);
  assert.equal(world.tenantRowsWritten() - claimBefore, 10);
  const state = sql
    .exec(
      "SELECT cursor_event_id, start_refusals_in_a_row FROM subscriptions WHERE subscription_id = ?",
      subscription.subscriptionId,
    )
    .one();
  assert.deepEqual({ ...state }, { cursor_event_id: eventId, start_refusals_in_a_row: 0 });
});
