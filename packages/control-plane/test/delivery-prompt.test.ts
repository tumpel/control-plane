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
    kind: "Batch",
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
  assert.ok(two?.kind === "Batch");
  const plan = "p".repeat(DELIVERY_PROMPT_LIMIT - two.prompt.length + "Plan.".length);
  const batch = deliveryPrompt(plan, "t1", events);
  assert.ok(batch?.kind === "Batch");
  assert.equal(batch.lastEventId, 2);
  assert.equal(batch.prompt.length, DELIVERY_PROMPT_LIMIT);
});

test("a delivery prompt delivers by reference an event too long to fit on its own", () => {
  const batch = deliveryPrompt("Plan.", "t1", [failed(41, "x".repeat(5000)), idle(42)]);
  assert.deepEqual(batch, {
    kind: "Batch",
    prompt: `Plan.\n\n${JSON.stringify({
      eventId: 41,
      event: "TurnFailed",
      sessionId: "crew-1",
      tooLongToInline:
        "read it in full with GET /v1/events?afterEventId=40&event=TurnFailed&sessionId=crew-1 (tumpel_events_list); it is the first event of the page",
    })}`,
    lastEventId: 41,
  });
  assert.ok(batch.prompt.length <= DELIVERY_PROMPT_LIMIT);
});

const refusal = (eventId: number, code: string, detail = "") => ({
  event_id: eventId,
  created_at: 1_000,
  payload: JSON.stringify({
    event: "StartRefused",
    operation: "Start",
    refusal: { code, detail },
    personaId: "foreman",
    model: "opus",
    caller: { kind: "Person", principalId: "person" },
    crewTags: ["crew:x"],
  }),
});

const capacity = (eventId: number) => ({
  event_id: eventId,
  created_at: 1_000,
  payload: JSON.stringify({ event: "CapacityAvailable", hostId: "host-1", code: "PoolExhausted" }),
});

test("delivery keeps the latest refusal by code and capacity signal within the longest fitting prefix", () => {
  const batch = deliveryPrompt("Plan.", "t1", [
    refusal(1, "PoolExhausted", "x".repeat(5_000)),
    capacity(2),
    idle(3),
    refusal(4, "PoolExhausted"),
    refusal(5, "ModelUnsupported"),
    capacity(6),
  ]);
  assert.ok(batch?.kind === "Batch");
  assert.deepEqual(
    batch.prompt
      .split("\n")
      .slice(2)
      .map((line) => JSON.parse(line).eventId),
    [3, 4, 5, 6],
  );
  assert.equal(batch.lastEventId, 6);
});

test("a long refusal reference includes its code", () => {
  const batch = deliveryPrompt("Plan.", "t1", [refusal(41, "PoolExhausted", "x".repeat(5_000))]);
  assert.deepEqual(batch, {
    kind: "Batch",
    prompt:
      'Plan.\n\n{"eventId":41,"event":"StartRefused","code":"PoolExhausted","tooLongToInline":"read it in full with GET /v1/events?afterEventId=40&event=StartRefused (tumpel_events_list); it is the first event of the page"}',
    lastEventId: 41,
  });
});

test("a refusal after the fitting crew-event prefix stays pending", () => {
  const batch = deliveryPrompt("Plan.", "t1", [idle(8), refusal(9, "ModelUnsupported", "x".repeat(5_000))]);
  assert.ok(batch?.kind === "Batch");
  assert.equal(batch.lastEventId, 8);
  assert.doesNotMatch(batch.prompt, /StartRefused/);
});
