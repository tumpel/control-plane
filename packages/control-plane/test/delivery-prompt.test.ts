import assert from "node:assert/strict";
import { test } from "node:test";
import { DELIVERY_PROMPT_LIMIT, deliveryPrompt } from "../src/delivery-prompt.ts";

const idle = (eventId: number) => ({
  event_id: eventId,
  payload: JSON.stringify({ event: "SessionIdle", sessionId: "crew-1", turnId: `turn-${eventId}` }),
  created_at: 1_000,
});

const failed = (eventId: number, detail: string) => ({
  event_id: eventId,
  payload: JSON.stringify({
    event: "TurnFailed",
    sessionId: "crew-1",
    turnId: "turn-1",
    reason: "HarnessReportedError",
    detail,
  }),
  created_at: 1_000,
});

test("a delivery prompt holds the plan, then one JSON line per event in order", () => {
  const batch = deliveryPrompt("Work the issues.", "t1", [idle(4), idle(7)]);
  assert.deepEqual(batch, {
    prompt: [
      "Work the issues.",
      "",
      '{"event":"SessionIdle","eventId":4,"tenantId":"t1","createdAt":1000,"sessionId":"crew-1","turnId":"turn-4"}',
      '{"event":"SessionIdle","eventId":7,"tenantId":"t1","createdAt":1000,"sessionId":"crew-1","turnId":"turn-7"}',
    ].join("\n"),
    lastEventId: 7,
  });
});

test("a delivery prompt drops the latest events until the message fits the limit", () => {
  const events = [idle(1), idle(2), idle(3)];
  const two = deliveryPrompt("Plan.", "t1", events.slice(0, 2));
  assert.ok(two !== null);
  const plan = "p".repeat(DELIVERY_PROMPT_LIMIT - two.prompt.length + "Plan.".length);
  const batch = deliveryPrompt(plan, "t1", events);
  assert.equal(batch?.lastEventId, 2);
  assert.equal(batch.prompt.length, DELIVERY_PROMPT_LIMIT);
});

test("a delivery prompt delivers by reference an event too long to fit on its own", () => {
  const batch = deliveryPrompt("Plan.", "t1", [failed(41, "x".repeat(5000)), idle(42)]);
  assert.deepEqual(batch, {
    prompt: `Plan.\n\n${JSON.stringify({
      eventId: 41,
      event: "TurnFailed",
      sessionId: "crew-1",
      tooLongToInline:
        "read it in full with GET /v1/events?afterEventId=40&event=TurnFailed&sessionId=crew-1 (tumpel_events_wait); it is the first event of the page",
    })}`,
    lastEventId: 41,
  });
  assert.ok(batch.prompt.length <= DELIVERY_PROMPT_LIMIT);
});
