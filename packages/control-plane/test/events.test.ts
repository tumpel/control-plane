import assert from "node:assert/strict";
import { test } from "node:test";
import { EventCursorExpiredProblemSchema } from "@tumpel/schemas";
import { eventCursorExpired } from "../src/http.ts";

test("an expired event cursor returns the oldest retained event id", async () => {
  const response = eventCursorExpired(12, 42);

  assert.equal(response.status, 410);
  assert.deepEqual(EventCursorExpiredProblemSchema.parse(await response.json()), {
    code: "EventCursorExpired",
    title: "Event cursor expired",
    detail: "event 12 is older than the oldest event kept, 42; the log keeps 7 days",
    fix: "Read the current state of what you follow, then read events again without afterEventId",
    oldestEventId: 42,
  });
});
