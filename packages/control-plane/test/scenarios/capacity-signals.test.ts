import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { PRINCIPAL_ID, TENANT_ID, World } from "./harness/world.ts";
import { mcpPersona, startBox } from "./signal-fixtures.ts";

const foremanIdleOnFullHost = async (t: TestContext, runningBox: boolean, auto: boolean, extraBox = false) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const personaId = await mcpPersona(world);
  const foreman = await startBox(world, host, personaId, "plan the work", "Warm", ["role:foreman"]);
  const subscription = await world.subscribe(foreman.session, {
    prompt: "Continue the work",
    goal: "Land the work",
    events: ["StartRefused", "CapacityAvailable", "TurnCompleted"],
    crewTags: ["crew:x"],
  });
  const crew = await startBox(world, host, personaId, "build the work", auto ? "Auto" : "Warm");
  if (!runningBox) await host.finishes(crew.offer);
  const extra = extraBox ? await startBox(world, host, personaId, "build another box", "Warm") : null;
  if (extra !== null) await host.finishes(extra.offer);
  host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib, diskHeldMib: 100_000 });
  await world.settle();
  const refuse = async (): Promise<void> => {
    assert.deepEqual(
      await world.call("recordStartRefusal", {
        tenantId: TENANT_ID,
        refusal: { code: "PoolExhausted", detail: "The host has no room." },
        caller: { kind: "Person", principalId: PRINCIPAL_ID },
        personaId,
        model: "opus",
        requestedTags: ["crew:x"],
        now: Date.now(),
      }),
      { kind: "Recorded" },
    );
  };
  await refuse();
  await host.finishes(foreman.offer);
  const refusal = host.takeOffer();
  assert.match(refusal.prompt, /"event":"StartRefused"/);
  await host.claims(refusal);
  await host.finishes(refusal);
  assert.equal((await world.session(foreman.session.sessionId)).state, "Idle");

  const sql = world.tenantSql();
  const signals = (): number =>
    Number(
      sql
        .exec("SELECT COUNT(*) AS count FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'")
        .one().count,
    );
  assert.equal(signals(), 0);
  const takeCapacity = () => {
    const offer = host.takeOffer();
    assert.equal(offer.sessionId, subscription.sessionId);
    assert.match(offer.prompt, /"event":"CapacityAvailable"/);
    return offer;
  };
  return { world, host, personaId, crew, extra, refuse, signals, takeCapacity };
};

test("a stop offers capacity once and a claim clears the wait and signal", async (t) => {
  const { world, host, crew, extra, signals, takeCapacity } = await foremanIdleOnFullHost(t, false, false, true);
  assert.ok(extra);
  const before = world.tenantRowsWritten();
  await host.dropsIdleBox(crew.offer);
  assert.equal(world.tenantRowsWritten() - before, 30);
  assert.equal(signals(), 1);
  const first = takeCapacity();

  const secondBefore = world.tenantRowsWritten();
  await host.dropsIdleBox(extra.offer);
  assert.equal(world.tenantRowsWritten() - secondBefore, 6);
  assert.equal(signals(), 1);
  assert.equal(host.holds("TurnOffer"), false);
  const sql = world.tenantSql();
  assert.equal(sql.exec("SELECT COUNT(*) AS count FROM subscription_room_signals").one().count, 1);
  const claimBefore = world.tenantRowsWritten();
  await host.claims(first);
  assert.equal(world.tenantRowsWritten() - claimBefore, 13);
  assert.equal(sql.exec("SELECT COUNT(*) AS count FROM subscription_room_waits").one().count, 0);
  assert.equal(sql.exec("SELECT COUNT(*) AS count FROM subscription_room_signals").one().count, 0);
  await host.says({
    type: "TurnFailed",
    turnId: first.turnId,
    reason: "NotClaimed",
    detail: "The host lost the claim reply.",
    failedAt: new Date(Date.now()).toISOString(),
  });
  const reoffered = host.takeOffer();
  assert.equal(reoffered.turnId, first.turnId);
  const reclaimBefore = world.tenantRowsWritten();
  await host.claims(reoffered);
  assert.equal(world.tenantRowsWritten() - reclaimBefore, 9);
  assert.equal(sql.exec("SELECT COUNT(*) AS count FROM subscription_room_waits").one().count, 0);
});

test("a stop needs a wait and a new refusal allows a later stop to signal", async (t) => {
  const { world, host, personaId, crew, extra, refuse, signals, takeCapacity } = await foremanIdleOnFullHost(
    t,
    false,
    false,
    true,
  );
  assert.ok(extra);
  await host.dropsIdleBox(crew.offer);
  const first = takeCapacity();
  await host.claims(first);
  await host.finishes(first);

  const withoutWait = world.tenantRowsWritten();
  await host.dropsIdleBox(extra.offer);
  assert.equal(world.tenantRowsWritten() - withoutWait, 6);
  assert.equal(signals(), 1);
  assert.equal(host.holds("TurnOffer"), false);

  host.report({ memoryHeldMib: 0 });
  await world.settle();
  const next = await startBox(world, host, personaId, "build another crew box", "Warm");
  await host.finishes(next.offer);
  await refuse();
  const refusal = host.takeOffer();
  await host.claims(refusal);
  await host.finishes(refusal);
  await host.dropsIdleBox(next.offer);
  assert.equal(signals(), 2);
  takeCapacity();
});

test("BoxGone and a later disk report answer successive waits", async (t) => {
  const { world, host, crew, refuse, signals, takeCapacity } = await foremanIdleOnFullHost(t, false, false);
  await host.dropsIdleBox(crew.offer);
  assert.equal(signals(), 1);
  const first = takeCapacity();
  await host.claims(first);
  await host.finishes(first);
  await refuse();
  const refusal = host.takeOffer();
  await host.claims(refusal);
  await host.finishes(refusal);
  host.report({ diskHeldMib: 50_000 });
  await world.settle();
  assert.equal(signals(), 1);
  await world.passes(30_001);
  host.report({ diskHeldMib: 50_000 });
  await world.settle();
  assert.equal(signals(), 2);
  takeCapacity();
});

for (const source of [
  "Archive",
  "Running BoxGone",
  "Stopping BoxGone",
  "Heartbeat",
  "Auto Idle",
  "Warm Idle",
] as const) {
  test(`an idle Foreman observes capacity from ${source}`, async (t) => {
    const { world, host, crew, signals, takeCapacity } = await foremanIdleOnFullHost(
      t,
      source.endsWith("Idle") || source === "Running BoxGone",
      source === "Auto Idle",
    );
    const { sessionId } = crew.session;
    if (source === "Archive") {
      const archived = await world.fetch(world.owner, "POST", `/v1/sessions/${sessionId}/archive`);
      assert.equal(archived.status, 200, await archived.clone().text());
    }
    if (source === "Running BoxGone" || source === "Stopping BoxGone") {
      if (source === "Stopping BoxGone") {
        const stopped = await world.fetch(world.owner, "POST", `/v1/sessions/${sessionId}/stop`);
        assert.equal(stopped.status, 200, await stopped.clone().text());
        assert.equal((await world.session(sessionId)).state, "Stopping");
      }
      await host.dropsIdleBox(crew.offer);
    }
    if (source === "Heartbeat") {
      await host.beats({ heldSessionIds: host.holding().heldSessionIds.filter((held) => held !== sessionId) });
    }
    if (source.endsWith("Idle")) await host.finishes(crew.offer);
    if (source === "Warm Idle") {
      assert.equal(signals(), 0);
      assert.equal(host.holds("TurnOffer"), false);
    } else {
      assert.equal(signals(), 1);
      takeCapacity();
    }
  });
}

test("a memory drop signals capacity without a box change", async (t) => {
  const { world, host, crew, signals, takeCapacity } = await foremanIdleOnFullHost(t, true, false);
  const before = world.tenantRowsWritten();
  host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib - 2_048 });
  await world.settle();
  assert.equal(signals(), 1);
  assert.equal((await world.session(crew.session.sessionId)).state, "Running");
  assert.equal(world.tenantRowsWritten() - before, 25);
  takeCapacity();
  for (const memoryHeldMib of [24_000, 23_000, 22_000]) {
    const change = world.tenantRowsWritten();
    host.report({ memoryHeldMib });
    await world.settle();
    assert.equal(world.tenantRowsWritten() - change, 1);
    assert.equal(signals(), 1);
    assert.equal(host.holds("TurnOffer"), false);
  }
});

test("a disk-only change signals when the heard-at refresh commits it", async (t) => {
  const { world, host, signals, takeCapacity } = await foremanIdleOnFullHost(t, true, false);
  await world.passes(30_000);
  const before = world.tenantRowsWritten();
  host.report({ diskHeldMib: 50_000 });
  await world.settle();
  assert.equal(world.tenantRowsWritten() - before, 0);
  assert.equal(signals(), 0);
  await world.passes(1);
  const commitBefore = world.tenantRowsWritten();
  host.report({ diskHeldMib: 50_000 });
  await world.settle();
  assert.equal(world.tenantRowsWritten() - commitBefore, 25);
  assert.equal(signals(), 1);
  takeCapacity();
});

test("a host becoming Healthy emits one HostDegraded capacity signal", async (t) => {
  const { world, host, signals, takeCapacity } = await foremanIdleOnFullHost(t, true, false);
  const heartbeat = () => ({
    type: "Heartbeat",
    sentAt: new Date(Date.now()).toISOString(),
    usage: { ...DEFAULT_USAGE, memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib, diskHeldMib: 100_000 },
    ...host.holding(),
    ack: host.carried().received,
    telemetry: { instruments: [], samples: [], turns: [] },
  });
  host.raw({ ...heartbeat(), health: "RateLimited" });
  await world.settle();
  assert.equal(signals(), 0);
  const before = world.tenantRowsWritten();
  host.raw({ ...heartbeat(), health: "Healthy" });
  await world.settle();
  assert.equal(signals(), 1);
  assert.equal(world.tenantRowsWritten() - before, 25);
  assert.match(takeCapacity().prompt, /"code":"HostDegraded"/);
  await host.beats();
  assert.equal(signals(), 1);
});

for (const presence of ["new host", "reconnect after grace"] as const) {
  test(`an idle Foreman receives one NoHostAvailable capacity signal on ${presence}`, async (t) => {
    const { world, host, signals } = await foremanIdleOnFullHost(t, false, false);
    if (presence === "reconnect after grace") {
      await host.closesSocket();
      await world.passes(world.settings.heartbeatDeadlineSeconds * 1000 + 1);
    }
    const before = world.tenantRowsWritten();
    const arrived = presence === "new host" ? await world.hostOnline("host-2") : await world.reconnect(host);
    await world.settle();
    assert.equal(signals(), 1);
    const signal = world
      .tenantSql()
      .exec(`
      SELECT json_extract(payload, '$.hostId') AS hostId, json_extract(payload, '$.code') AS code
      FROM events WHERE json_extract(payload, '$.event') = 'CapacityAvailable'`)
      .one();
    assert.deepEqual({ ...signal }, { hostId: arrived.hostId, code: "NoHostAvailable" });
    assert.equal(world.tenantRowsWritten() - before, 28);
    await arrived.beats();
    assert.equal(signals(), 1);
  });
}
