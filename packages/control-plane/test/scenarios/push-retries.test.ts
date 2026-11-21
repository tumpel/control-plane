import assert from "node:assert/strict";
import { test } from "node:test";
import { SubscriptionSchema } from "@tumpel/schemas";
import { z } from "zod";
import { PRINCIPAL_ID, SETTINGS, TENANT_ID, World } from "./harness/world.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const subscribedForPushes = async (world: World, expiresInMs: number) => {
  await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "watch the epic", tags: ["role:foreman"] });
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  await world.call("createPushSubscription", {
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    subscription: {
      endpoint: "https://push.scenario.test/subscription",
      keys: {
        p256dh: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url"),
        auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
      },
      events: ["SubscriptionPaused", "SubscriptionEnded"],
    },
    now: Date.now(),
  });
  const { created } = z.object({ created: z.object({ subscription: SubscriptionSchema }) }).parse(
    await world.call("createSubscription", {
      tenantId: TENANT_ID,
      now: Date.now(),
      subscription: {
        sessionId: session.sessionId,
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
        prompt: "hand out the next step",
        goal: "the epic is merged",
        events: ["TurnCompleted"],
        crewTags: ["crew:epic"],
      },
    }),
  );
  return created.subscription;
};

const pushLines = (lines: string[]): string[] => lines.filter((line) => line.startsWith("PushDeliveryFailed:"));

test("a push the push service always refuses with 500 gets 10 retries with growing gaps, then is dropped", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const logged: string[] = [];
  t.mock.method(console, "error", (line: string) => logged.push(line));
  const posts: number[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    posts.push(Date.now());
    return new Response(null, { status: 500 });
  });
  const subscription = await subscribedForPushes(world, 7 * DAY);

  await world.call("pauseSubscription", {
    tenantId: TENANT_ID,
    subscriptionId: subscription.subscriptionId,
    message: "Choose a release.",
    now: Date.now(),
  });
  await world.passes(DAY);

  assert.equal(posts.length, 11, "the first push and 10 retries");
  const gaps = posts.slice(1).map((at, index) => at - (posts[index] ?? 0));
  assert.ok((gaps[0] ?? 0) >= MINUTE / 2 && (gaps[0] ?? 0) <= MINUTE, `first gap ${gaps[0]}`);
  for (const [index, gap] of gaps.entries()) {
    if (index > 0) assert.ok(gap >= (gaps[index - 1] ?? 0), `gap ${index + 1} (${gap}) shrank`);
  }
  assert.deepEqual(
    pushLines(logged).map((line) => line.replace(/^PushDeliveryFailed: push subscription \S+ dropped event \d+: /, "")),
    ["the push service still failed after 10 retries: HTTP 500"],
  );
});

test("a push no retry can send is dropped at once, and the subscription still expires on time", async (t) => {
  const world = await World.open({ vapidKey: "Unreadable" });
  t.after(() => world.close());
  const logged: string[] = [];
  t.mock.method(console, "error", (line: string) => logged.push(line));
  const posts: number[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    posts.push(Date.now());
    return new Response(null, { status: 201 });
  });
  const subscription = await subscribedForPushes(world, 10 * MINUTE);

  await world.call("pauseSubscription", {
    tenantId: TENANT_ID,
    subscriptionId: subscription.subscriptionId,
    message: "Choose a release.",
    now: Date.now(),
  });
  await world.passes(MINUTE);
  assert.equal(pushLines(logged).length, 1, "the paused push is dropped on its first try");
  assert.match(pushLines(logged)[0] ?? "", /, which no retry changes$/);

  await world.passes(10 * MINUTE);
  assert.equal((await world.subscription(subscription.subscriptionId)).state, "Ended");
  assert.equal(pushLines(logged).length, 2, "the ended push is dropped on its first try too");
  assert.equal(posts.length, 0);
  await world.passes(7 * DAY);
  assert.equal(pushLines(logged).length, 2);
});

test("deleting a session drops its pending pushes, so the tenant alarm does not refire for them", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  t.mock.method(console, "error", () => undefined);
  const posts: number[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    posts.push(Date.now());
    return new Response(null, { status: 500 });
  });
  const subscription = await subscribedForPushes(world, 7 * DAY);
  await world.call("pauseSubscription", {
    tenantId: TENANT_ID,
    subscriptionId: subscription.subscriptionId,
    message: "Choose a release.",
    now: Date.now(),
  });
  await world.passes(SETTINGS.turnTotalBudgetSeconds * 1000);
  assert.equal((await world.session(subscription.sessionId)).state, "Stopped");

  const { deleted } = z
    .object({ deleted: z.object({ kind: z.string() }) })
    .parse(await world.call("deleteSession", { tenantId: TENANT_ID, sessionId: subscription.sessionId }));
  assert.equal(deleted.kind, "Deleted");
  const sent = posts.length;
  await world.passes(DAY);

  assert.equal(posts.length, sent, "no push for the deleted session is tried again");
  const alarm = await world.tenantAlarm();
  assert.ok(alarm === null || alarm > Date.now() + MINUTE, "the tenant alarm is not left overdue");
});
