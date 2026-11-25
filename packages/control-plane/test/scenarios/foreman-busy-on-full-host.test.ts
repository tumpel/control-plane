import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { HostRecordSchema, SendTurnResultSchema, StartSessionResultSchema, TenantEventSchema } from "@tumpel/schemas";
import { CLAUDE_CODE_VERSION } from "../../src/harness-catalog.ts";
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
    events: ["StartRefused", "TurnCompleted", "TurnFailed"],
    crewTags: ["crew:x"],
  });
  await world.passes(1);
  const sql = world.tenantSql();
  const count = (): number =>
    Number(
      sql
        .exec(
          "SELECT start_refusals_in_a_row FROM subscriptions WHERE subscription_id = ?",
          subscription.subscriptionId,
        )
        .one().start_refusals_in_a_row,
    );
  const deliveries = (): number =>
    Number(
      sql
        .exec("SELECT COUNT(*) AS count FROM subscription_turns WHERE subscription_id = ?", subscription.subscriptionId)
        .one().count,
    );
  const refuse = async (caller: TurnOffer): Promise<number> => {
    const before = world.tenantRowsWritten();
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
    return world.tenantRowsWritten() - before;
  };
  const read = await world.fetch(world.owner, "GET", `/v1/hosts/${host.hostId}`);
  assert.equal(read.status, 200);
  const hostRecord = HostRecordSchema.parse(await read.json());
  return { world, host, personaId, foreman, subscription, count, deliveries, refuse, hostRecord };
};

test("foremanBusyOnFullHost: nine refusals keep one delivery and the tenth pauses StartsRefused", async (t) => {
  const { world, host, foreman, subscription, count, deliveries, refuse } = await fixture(t);
  for (let refused = 1; refused <= 9; refused++) {
    assert.equal(await refuse(foreman.offer), refused === 1 ? 11 : 3);
    assert.equal(count(), refused);
    assert.equal(deliveries(), 1);
  }
  assert.equal((await world.subscription(subscription.subscriptionId)).state, "Active");

  assert.equal(await refuse(foreman.offer), 24);
  assert.equal(count(), 10);
  assert.equal(deliveries(), 0);
  const paused = await world.subscription(subscription.subscriptionId);
  assert.equal(paused.state, "Paused");
  assert.deepEqual(paused.state === "Paused" && paused.reason, { kind: "StartsRefused" });
  const listed = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=SubscriptionPaused");
  assert.equal(listed.status, 200);
  const pauses = TenantEventSchema.array().parse((await listed.json()).events);
  assert.deepEqual(
    pauses.map((event) => event.event === "SubscriptionPaused" && event.reason),
    [{ kind: "StartsRefused" }],
  );
  await host.finishes(foreman.offer);
  assert.equal(host.holds("TurnOffer"), false);

  const resumed = await world.fetch(world.owner, "POST", `/v1/subscriptions/${subscription.subscriptionId}/resume`);
  assert.equal(resumed.status, 200, await resumed.clone().text());
  assert.equal(count(), 0);
});

test("foremanBusyOnFullHost: nine refusals and nine crew failures pause neither, and crew success keeps the refusal count", async (t) => {
  const { world, host, personaId, foreman, subscription, count, refuse } = await fixture(t);
  const crew = await startBox(world, host, personaId, "build the work", "Warm", ["crew:x"]);
  let crewTurn = crew.offer;
  for (let failed = 1; failed <= 9; failed++) {
    await host.says({
      type: "TurnFailed",
      turnId: crewTurn.turnId,
      reason: "HarnessReportedError",
      detail: "the harness stopped",
      failedAt: new Date(Date.now()).toISOString(),
    });
    await host.answersSnapshot(crew.session.sessionId);
    await world.sendTurn(crew.session.sessionId, "try again");
    crewTurn = host.takeOffer();
    await host.claims(crewTurn);
    await refuse(foreman.offer);
  }
  const read = await world.subscription(subscription.subscriptionId);
  assert.equal(read.state, "Active");
  assert.equal(read.crewFailuresInARow, 9);
  assert.equal(count(), 9);

  await host.finishes(crewTurn);
  const after = await world.subscription(subscription.subscriptionId);
  assert.equal(after.state, "Active");
  assert.equal(after.crewFailuresInARow, 0);
  assert.equal(count(), 9);
});

test("foremanBusyOnFullHost: a successful start or send by the Foreman resets the refusal count, and an unrelated crew start does not", async (t) => {
  const { world, host, personaId, foreman, count, refuse, hostRecord } = await fixture(t);
  const other = await startBox(world, host, personaId, "plan other work", "Warm", ["crew:x"]);
  const start = async (caller: TurnOffer): Promise<number> => {
    const before = world.tenantRowsWritten();
    const { started } = StartSessionResultSchema.parse(
      await world.call("startSession", {
        tenantId: TENANT_ID,
        input: {
          principalId: PRINCIPAL_ID,
          startedBy: { kind: "Turn", sessionId: caller.sessionId, turnId: caller.turnId },
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
        now: Date.now(),
      }),
    );
    const delta = world.tenantRowsWritten() - before;
    assert.equal(started.kind, "Started");
    assert.equal(host.takeOffer().sessionId, started.started.session.sessionId);
    return delta;
  };
  const send = async (caller: TurnOffer): Promise<number> => {
    const before = world.tenantRowsWritten();
    const { sent } = SendTurnResultSchema.parse(
      await world.call("sendTurn", {
        tenantId: TENANT_ID,
        sessionId: other.session.sessionId,
        send: { prompt: "continue the work" },
        hosts: [hostRecord],
        caller: { kind: "Turn", sessionId: caller.sessionId, turnId: caller.turnId },
        now: Date.now(),
      }),
    );
    assert.equal(sent.kind, "Sent");
    const delta = world.tenantRowsWritten() - before;
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.finishes(offer);
    return delta;
  };

  await refuse(foreman.offer);
  assert.equal(count(), 1);
  const baseline = await start(other.offer);
  assert.equal(count(), 1);
  assert.equal(await start(foreman.offer), baseline + 1);
  assert.equal(count(), 0);
  assert.equal(await start(foreman.offer), baseline);

  await host.finishes(other.offer);
  await refuse(foreman.offer);
  assert.equal(count(), 1);
  await send(foreman.offer);
  assert.equal(count(), 0);
  const sendBaseline = await send(foreman.offer);
  await refuse(foreman.offer);
  assert.equal(await send(foreman.offer), sendBaseline + 1);
  assert.equal(count(), 0);
});
