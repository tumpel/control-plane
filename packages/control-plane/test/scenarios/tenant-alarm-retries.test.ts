import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { SubscriptionSchema } from "@tumpel/schemas";
import { z } from "zod";
import { TENANT_ID, World } from "./harness/world.ts";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const subscribe = async (world: World, sessionId: string, expiresInMs: number): Promise<string> => {
  const { created } = z.object({ created: z.object({ subscription: SubscriptionSchema }) }).parse(
    await world.call("createSubscription", {
      tenantId: TENANT_ID,
      now: Date.now(),
      subscription: {
        sessionId,
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
        prompt: "hand out the next step",
        goal: "the epic is merged",
        events: ["TurnCompleted"],
        crewTags: ["crew:epic"],
      },
    }),
  );
  return created.subscription.subscriptionId;
};

const failingExpiry = async (world: World, t: TestContext) => {
  await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "watch the epic", tags: ["role:foreman"] });
  const logged: string[] = [];
  t.mock.method(console, "error", (line: string) => logged.push(line));
  t.mock.method(world.tenantSteps(), "expireSubscriptions", () => {
    throw new Error("the subscription store is unreadable");
  });
  return { sessionId: session.sessionId, logged };
};

test("after a hard failure the tenant alarm starts a fresh 10 retries for work that falls due later", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const { sessionId, logged } = await failingExpiry(world, t);
  await subscribe(world, sessionId, 10 * MINUTE);
  await subscribe(world, sessionId, 2 * DAY);

  await world.passes(DAY);
  const retries = (lines: string[]) =>
    lines.filter((line) => line.startsWith("TenantAlarmRetry:")).map((line) => line.split(" ")[4]);
  const failures = (lines: string[]) => lines.filter((line) => line.startsWith("TenantAlarmFailed:"));
  assert.deepEqual(retries(logged), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  assert.equal(failures(logged).length, 1);
  assert.ok(((await world.tenantAlarm()) ?? 0) >= Date.now() + 12 * 3_600_000, "only the later expiry is armed");

  const later = logged.length;
  await world.passes(2 * DAY);
  assert.deepEqual(retries(logged.slice(later)), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  assert.equal(failures(logged.slice(later)).length, 1);
  assert.equal(await world.tenantAlarm(), null);
});

test("requests during a pending tenant alarm retry never move the retry later", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const { sessionId, logged } = await failingExpiry(world, t);
  const subscriptionId = await subscribe(world, sessionId, 10 * MINUTE);

  await world.passes(10 * MINUTE);
  assert.equal(logged.filter((line) => line.startsWith("TenantAlarmRetry:")).length, 1);
  const retryAt = await world.tenantAlarm();
  assert.ok((retryAt ?? 0) > Date.now(), "the retry waits out its backoff");
  for (let request = 0; request < 3; request += 1) {
    await world.call("getSubscription", { tenantId: TENANT_ID, subscriptionId });
    assert.equal(await world.tenantAlarm(), retryAt);
  }
});
