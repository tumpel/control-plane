import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol, ListEventsResultSchema, SubscriptionSchema } from "@tumpel/schemas";
import { TENANT_ID, World } from "./harness/world.ts";

type EventLog = { appendEvent(event: Record<string, unknown>, now: number): number };

test("a resumed subscription whose stopped session needs a box, after a tenant restart no host has said hello to, fails its delivery, leaves the tenant serving, and refuses the host's heartbeat until it says hello again", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");

  const foreman = await world.startSession({ prompt: "plan the epic", tags: ["role:foreman"] });
  const subscription = await world.subscribe(foreman, {
    prompt: "hand out the next step of the epic",
    goal: "the epic is merged",
    events: ["TurnFailed"],
    crewTags: ["crew:epic"],
  });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);
  await host.dropsIdleBox(foremanTurn);
  assert.equal((await world.session(foreman.sessionId)).state, "Stopped");
  const crew = await world.startSession({ prompt: "build part one", tags: ["crew:epic"] });
  assert.equal(host.takeOffer().sessionId, crew.sessionId);

  const path = `/v1/subscriptions/${subscription.subscriptionId}`;
  const paused = await world.fetch(world.owner, "POST", `${path}/pause`, JSON.stringify({ message: "hold on" }));
  assert.equal(paused.status, 200);
  const log = world.tenantSteps() as unknown as EventLog;
  log.appendEvent(
    {
      event: "TurnFailed",
      turnId: "turn-crew",
      sessionId: crew.sessionId,
      reason: "HarnessReportedError",
      detail: "the harness exited",
    },
    Date.now(),
  );

  world.restartTenant();
  await world.runtime.settle();

  const resumed = await world.fetch(world.owner, "POST", `${path}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal(SubscriptionSchema.parse(await resumed.json()).state, "Active");
  const listed = await world.fetch(world.owner, "GET", "/v1/subscriptions");
  assert.equal(listed.status, 200);

  const { listed: failures } = ListEventsResultSchema.parse(
    await world.call("listEvents", {
      tenantId: TENANT_ID,
      afterEventId: 0,
      events: ["TurnFailed"],
      sessionId: foreman.sessionId,
      triggerId: null,
    }),
  );
  assert.equal(failures.kind, "Read");
  const [failed] = failures.page.events;
  assert.equal(failed?.event, "TurnFailed");
  assert.equal(failed.reason, "PoolExhausted");
  assert.match(failed.detail, /host-1 has not said hello since your tenant restarted/);

  const usage = { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000 };
  const heartbeat = () => world.call("hostUsage", { hostId: host.hostId, usage, now: Date.now() });
  await assert.rejects(heartbeat(), /HostUnheard/);
  await world.call("hostHello", {
    tenantId: TENANT_ID,
    hostId: host.hostId,
    boxCapacity: 8,
    usage,
    now: Date.now(),
    channelProtocol: ChannelProtocol.Version,
    heldTurnIds: [],
  });
  await heartbeat();
  const next = await world.startSession({ prompt: "build part two", tags: [] });
  assert.equal(host.takeOffer().sessionId, next.sessionId);
});
