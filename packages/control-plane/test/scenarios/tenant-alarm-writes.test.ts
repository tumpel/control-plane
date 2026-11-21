import assert from "node:assert/strict";
import { test } from "node:test";
import { SubscriptionSchema } from "@tumpel/schemas";
import { z } from "zod";
import { TENANT_ID, World } from "./harness/world.ts";

const MINUTE = 60 * 1000;
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

test("tenant calls that leave the next alarm time unchanged set the alarm once", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "watch the epic", tags: ["role:foreman"] });
  const subscriptionId = await subscribe(world, session.sessionId, 2 * DAY);
  await world.passes(2 * MINUTE);
  assert.ok(((await world.tenantAlarm()) ?? 0) > Date.now() + DAY, "only the subscription expiry is armed");
  const setAlarm = t.mock.method(world.tenantStorage(), "setAlarm");

  for (let call = 0; call < 100; call += 1) {
    await world.call("getSubscription", { tenantId: TENANT_ID, subscriptionId });
  }

  assert.equal(setAlarm.mock.callCount(), 1);
  assert.ok(((await world.tenantAlarm()) ?? Infinity) <= Date.now() + MINUTE, "the usage flush is armed");

  const earlier = Date.now() + 1000;
  await subscribe(world, session.sessionId, 1000);
  assert.equal(setAlarm.mock.callCount(), 2);
  assert.equal(await world.tenantAlarm(), earlier);

  await world.passes(2 * MINUTE);
  assert.ok(((await world.tenantAlarm()) ?? 0) > Date.now() + DAY, "the fired alarms re-arm for the later expiry");
});
