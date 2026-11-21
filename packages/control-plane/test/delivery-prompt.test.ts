import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryPrompt, subscriptionPrompt } from "../src/delivery-prompt.ts";

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
  const batch = deliveryPrompt("Work the issues.", "all closed", "t1", [idle(4), idle(7)], 4000);
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
  const two = deliveryPrompt("Plan.", "done", "t1", events.slice(0, 2), 4000);
  assert.ok(two !== null);
  const batch = deliveryPrompt("Plan.", "done", "t1", events, subscriptionPrompt(two.prompt, "done").length);
  assert.deepEqual(batch, two);
});

test("a delivery prompt delivers by reference an event too long to fit on its own", () => {
  const batch = deliveryPrompt("Plan.", "done", "t1", [failed(41, "x".repeat(5000)), idle(42)], 4000);
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
  assert.ok(subscriptionPrompt(batch.prompt, "done").length <= 4000);
});
