import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChannelProtocol,
  GetTurnFailureResultSchema,
  ListEventsResultSchema,
  SubscriptionSchema,
} from "@tumpel/schemas";
import { z } from "zod";
import { DELIVERY_PROMPT_LIMIT } from "../../src/delivery-prompt.ts";
import { TENANT_ID, World } from "./harness/world.ts";

type EventLog = { appendEvent(event: Record<string, unknown>, now: number): number };

test("a subscription resumes over a backlog that holds a TurnFailed event stored before its detail was bounded", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");

  const foreman = await world.startSession({ prompt: "plan the epic", tags: ["role:foreman"] });
  const subscription = await world.subscribe(foreman, {
    prompt: "p".repeat(90000),
    goal: "the epic is merged",
    events: ["TurnFailed"],
    crewTags: ["crew:epic"],
  });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);
  const crew = await world.startSession({ prompt: "build part one", tags: ["crew:epic"] });
  assert.equal(host.takeOffer().sessionId, crew.sessionId);

  const path = `/v1/subscriptions/${subscription.subscriptionId}`;
  const paused = await world.fetch(world.owner, "POST", `${path}/pause`, JSON.stringify({ message: "hold on" }));
  assert.equal(paused.status, 200);

  const log = world.tenantSteps() as unknown as EventLog;
  const failed = (turnId: string, detail: string) =>
    log.appendEvent(
      { event: "TurnFailed", turnId, sessionId: crew.sessionId, reason: "HarnessReportedError", detail },
      Date.now(),
    );
  const legacy = failed("turn-legacy", "x".repeat(20_000));
  failed("turn-2", "the harness exited");
  failed("turn-3", "the harness exited");

  const before = world.tenantRowsWritten();
  world.restartTenant();
  await world.runtime.settle();
  assert.equal(world.tenantRowsWritten() - before, 0, "the restart rewrites no stored event");
  await world.call("hostHello", {
    hostId: host.hostId,
    boxCapacity: 8,
    usage: { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000 },
    now: Date.now(),
    channelProtocol: ChannelProtocol.Version,
  });

  const resumed = await world.fetch(world.owner, "POST", `${path}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal(SubscriptionSchema.parse(await resumed.json()).state, "Active");

  const delivery = host.takeOffer();
  assert.equal(delivery.sessionId, foreman.sessionId);
  assert.ok(delivery.prompt.length <= DELIVERY_PROMPT_LIMIT);
  assert.match(delivery.prompt, new RegExp(`"eventId":${legacy},"event":"TurnFailed"`));

  const { listed } = ListEventsResultSchema.parse(
    await world.call("listEvents", {
      tenantId: TENANT_ID,
      afterEventId: legacy - 1,
      events: ["TurnFailed"],
      sessionId: crew.sessionId,
      triggerId: null,
    }),
  );
  assert.equal(listed.kind, "Read");
  const [event] = listed.page.events;
  assert.equal(event?.event, "TurnFailed");
  assert.equal(event.eventId, legacy);
  assert.equal(event.detail, "x".repeat(16384));
});

test("a turn failed by a snapshot failure stores a detail within the event bound, with no split surrogate pair", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");

  await world.startSession({ prompt: "write a long answer", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const request = z.object({ snapshotId: z.string() }).parse(host.take("SnapshotRequest"));
  await host.says({
    type: "SnapshotFailed",
    snapshotId: request.snapshotId,
    reason: "UploadRejected",
    detail: "😀".repeat(8192),
    failedAt: new Date(Date.now()).toISOString(),
  });

  const { failure } = GetTurnFailureResultSchema.parse(
    await world.call("getTurnFailure", { tenantId: TENANT_ID, turnId: offer.turnId }),
  );
  assert.equal(failure?.reason, "SnapshotNotStored");
  assert.match(failure.detail, /the snapshot of its work was not stored.*: snapshot .* failed UploadRejected: 😀/);
  assert.equal(failure.detail.length, 16384);
  assert.ok(failure.detail.isWellFormed());

  const { listed } = ListEventsResultSchema.parse(
    await world.call("listEvents", {
      tenantId: TENANT_ID,
      afterEventId: 0,
      events: ["TurnFailed"],
      sessionId: offer.sessionId,
      triggerId: null,
    }),
  );
  assert.equal(listed.kind, "Read");
  const [event] = listed.page.events;
  assert.equal(event?.event, "TurnFailed");
  assert.equal(event.detail, failure.detail);
});
