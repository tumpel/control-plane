import assert from "node:assert/strict";
import { test } from "node:test";
import { SubscriptionSchema } from "@tumpel/schemas";
import { DELIVERY_PROMPT_LIMIT } from "../../src/delivery-prompt.ts";
import { World } from "./harness/world.ts";

type EventLog = { appendEvent(event: Record<string, unknown>, now: number): number };

const BACKLOG = 3000;
const RESUME_ROWS_WRITTEN = 20;

test("a subscription resumes over a backlog of thousands of events, one written before event details were bounded, and delivers it in bounded turns", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");

  const foreman = await world.startSession({ prompt: "plan the epic", tags: ["role:foreman"] });
  const subscription = await world.subscribe(foreman, {
    prompt: "hand out the next step of the epic",
    goal: "the epic is merged",
    events: ["TurnCompleted", "TurnFailed"],
    crewTags: ["crew:epic"],
  });
  const foremanTurn = host.takeOffer();
  await host.claims(foremanTurn);
  await host.finishes(foremanTurn);
  const crew = await world.startSession({ prompt: "build part one", tags: ["crew:epic"] });
  const crewTurn = host.takeOffer();
  await host.claims(crewTurn);
  await host.finishes(crewTurn);
  const caughtUp = host.takeOffer();
  await host.claims(caughtUp);
  await host.finishes(caughtUp);

  const path = `/v1/subscriptions/${subscription.subscriptionId}`;
  const paused = await world.fetch(world.owner, "POST", `${path}/pause`, JSON.stringify({ message: "hold on" }));
  assert.equal(paused.status, 200);
  const cursor = SubscriptionSchema.parse(await paused.json()).cursorEventId;

  const log = world.tenantSteps() as unknown as EventLog;
  const legacy = log.appendEvent(
    {
      event: "TurnFailed",
      turnId: "turn-legacy",
      sessionId: crew.sessionId,
      reason: "HarnessReportedError",
      detail: "x".repeat(20_000),
    },
    Date.now(),
  );
  for (let n = 0; n < BACKLOG; n++) {
    log.appendEvent({ event: "TurnCompleted", turnId: `turn-${n}`, sessionId: crew.sessionId }, Date.now());
  }
  world.tenantSql().exec("DELETE FROM __migrations WHERE name = '0089_bound_event_details'");
  world.restartTenant();

  const before = world.tenantRowsWritten();
  const resumed = await world.fetch(world.owner, "POST", `${path}/resume`);
  assert.equal(resumed.status, 200);
  assert.equal(SubscriptionSchema.parse(await resumed.json()).state, "Active");
  const written = world.tenantRowsWritten() - before;
  assert.ok(written <= RESUME_ROWS_WRITTEN, `resuming over ${BACKLOG} events wrote ${written} rows`);

  const first = host.takeOffer();
  assert.equal(first.sessionId, foreman.sessionId);
  assert.ok(first.prompt.length <= DELIVERY_PROMPT_LIMIT);
  assert.match(first.prompt, new RegExp(`"eventId":${legacy},`));
  await host.claims(first);
  await host.finishes(first);
  const afterFirst = (await world.subscription(subscription.subscriptionId)).cursorEventId;
  assert.ok(afterFirst > cursor);
  assert.ok(afterFirst < cursor + BACKLOG, "one turn delivers a batch, never the whole backlog");

  const second = host.takeOffer();
  assert.ok(second.prompt.length <= DELIVERY_PROMPT_LIMIT);
  assert.match(second.prompt, new RegExp(`"eventId":${afterFirst + 1},`));
});
