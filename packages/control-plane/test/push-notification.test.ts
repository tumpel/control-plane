import assert from "node:assert/strict";
import { test } from "node:test";
import { pushNotification } from "../src/push-notification.ts";

test("a requested subscription pause carries its message", () => {
  assert.deepEqual(
    pushNotification(
      {
        event: "SubscriptionPaused",
        eventId: 42,
        tenantId: "tenant-1",
        createdAt: 1_795_200_000_000,
        subscriptionId: "subscription-1",
        sessionId: "session-1",
        reason: { kind: "ByRequest", message: "Choose which release to publish." },
      },
      "fix-login",
    ),
    {
      title: "Subscription paused in fix-login",
      body: "Choose which release to publish.",
      path: "/t/tenant-1/sessions/session-1",
    },
  );
});
