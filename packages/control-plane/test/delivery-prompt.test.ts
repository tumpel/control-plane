import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryPrompt } from "../src/delivery-prompt.ts";

const idle = (eventId: number) => ({
  event_id: eventId,
  payload: JSON.stringify({ event: "SessionIdle", sessionId: "crew-1", turnId: `turn-${eventId}` }),
  created_at: 1_000,
});

const fold = (prompt: string, goal: string) => `/goal ${prompt}\n\nDone when: ${goal}. Or stop after 5 turns.`;

test("a delivery prompt holds the plan, then one JSON line per event in order", () => {
  const batch = deliveryPrompt("Work the issues.", "all closed", "t1", [idle(4), idle(7)], fold, 4000);
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

test("a delivery prompt drops the latest events until the folded message fits the limit", () => {
  const events = [idle(1), idle(2), idle(3)];
  const full = deliveryPrompt("Plan.", "done", "t1", events, fold, 4000);
  const two = deliveryPrompt("Plan.", "done", "t1", events.slice(0, 2), fold, 4000);
  assert.ok(full !== null && two !== null);
  const batch = deliveryPrompt("Plan.", "done", "t1", events, fold, fold(two.prompt, "done").length);
  assert.equal(batch?.lastEventId, 2);
  assert.equal(batch?.prompt, two.prompt);
});

test("a delivery prompt keeps one event even when it overflows the limit", () => {
  const batch = deliveryPrompt("Plan.", "done", "t1", [idle(1), idle(2)], fold, 10);
  assert.equal(batch?.lastEventId, 1);
});
