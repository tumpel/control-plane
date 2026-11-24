import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { PRINCIPAL_ID, TENANT_ID, World } from "./harness/world.ts";
import { mcpPersona, startBox } from "./signal-fixtures.ts";

const f2 = async (t: TestContext, runningBox: boolean, auto: boolean, extraBox = false) => {
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

test("F2 gets one capacity signal on stop, stays quiet on a second stop, then signals after a new refusal", async (t) => {
  const { world, host, personaId, crew, extra, signals, refuse, takeCapacity } = await f2(t, false, false, true);
  assert.ok(extra);
  const before = world.tenantRowsWritten();
  await host.dropsIdleBox(crew.offer);
  assert.equal(signals(), 1);
  const first = takeCapacity();
  const signalDelta = world.tenantRowsWritten() - before;

  const secondBefore = world.tenantRowsWritten();
  await host.dropsIdleBox(extra.offer);
  const stopBaseline = world.tenantRowsWritten() - secondBefore;
  assert.equal(signals(), 1);
  assert.equal(host.holds("TurnOffer"), false);
  assert.equal(signalDelta, 30);
  assert.equal(stopBaseline, 7);
  await host.claims(first);
  await host.finishes(first);

  host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib - 2_048 });
  await world.settle();
  assert.equal(signals(), 1);
  await refuse();
  const newRefusal = host.takeOffer();
  await host.claims(newRefusal);
  await host.finishes(newRefusal);
  host.report({ diskHeldMib: 50_000 });
  await world.settle();
  assert.equal(signals(), 1);
  await world.passes(30_001);
  host.report({ diskHeldMib: 50_000 });
  await world.settle();
  assert.equal(signals(), 2);
  const diskSignal = takeCapacity();
  await host.claims(diskSignal);
  await host.finishes(diskSignal);

  const nextCrew = await startBox(world, host, personaId, "build another crew box", "Warm");
  await host.finishes(nextCrew.offer);
  await refuse();
  const nextRefusal = host.takeOffer();
  await host.claims(nextRefusal);
  await host.finishes(nextRefusal);
  const nextStop = world.tenantRowsWritten();
  await host.dropsIdleBox(nextCrew.offer);
  assert.equal(signals(), 3);
  assert.equal(world.tenantRowsWritten() - nextStop, 30);
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
  test(`F2 observes capacity from ${source}`, async (t) => {
    const { world, host, crew, signals, takeCapacity } = await f2(
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

test("F2 reports a memory drop without a box change", async (t) => {
  const { world, host, crew, signals, takeCapacity } = await f2(t, true, false);
  const before = world.tenantRowsWritten();
  host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib - 2_048 });
  await world.settle();
  assert.equal(signals(), 1);
  assert.equal((await world.session(crew.session.sessionId)).state, "Running");
  assert.equal(world.tenantRowsWritten() - before, 24);
  takeCapacity();
});

test("F2 commits a disk-only change on the heard-at refresh", async (t) => {
  const { world, host, signals, takeCapacity } = await f2(t, true, false);
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
  assert.equal(world.tenantRowsWritten() - commitBefore, 24);
  assert.equal(signals(), 1);
  takeCapacity();
});

test("F2 emits one HostDegraded signal when the host reports Healthy again", async (t) => {
  const { world, host, signals, takeCapacity } = await f2(t, true, false);
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
  assert.equal(world.tenantRowsWritten() - before, 24);
  assert.match(takeCapacity().prompt, /"code":"HostDegraded"/);
  await host.beats();
  assert.equal(signals(), 1);
});

for (const presence of ["new host", "reconnect after grace"] as const) {
  test(`F2 emits one NoHostAvailable signal on ${presence}`, async (t) => {
    const { world, host, signals } = await f2(t, false, false);
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
