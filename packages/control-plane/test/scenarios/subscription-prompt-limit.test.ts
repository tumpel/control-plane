import assert from "node:assert/strict";
import { test } from "node:test";
import { OfferedTurnSchema, ProblemSchema, SubscriptionSchema } from "@tumpel/schemas";
import { deliveryPrompt, subscriptionPrompt, widestReference } from "../../src/delivery-prompt.ts";
import { World } from "./harness/world.ts";

test("subscription creation and delivery accept 100000 characters and refuse one over", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "plan the epic", tags: [] });
  const goal = "g".repeat(10000);
  const reference = widestReference(["TurnFailed"]);
  const overhead = subscriptionPrompt("", goal).length + 2 + reference.length;
  const plan = "p".repeat(100000 - overhead);
  const subscription = {
    sessionId: session.sessionId,
    prompt: plan,
    goal,
    events: ["TurnFailed"],
    crewTags: [],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const created = await world.fetch(world.owner, "POST", "/v1/subscriptions", JSON.stringify(subscription));
  assert.equal(created.status, 200, await created.clone().text());
  assert.equal(SubscriptionSchema.parse(await created.json()).prompt, plan);

  const event = {
    event_id: Number.MAX_SAFE_INTEGER,
    payload: JSON.stringify({
      event: "TurnFailed",
      sessionId: "x".repeat(64),
      turnId: "turn-1",
      reason: "HarnessReportedError",
      detail: "x".repeat(16384),
    }),
    created_at: 1000,
  };
  const batch = deliveryPrompt(subscriptionPrompt(plan, goal), "t1", [event]);
  assert.ok(batch?.kind === "Batch");
  assert.equal(batch.prompt, `${subscriptionPrompt(plan, goal)}\n\n${reference}`);
  assert.equal(batch.prompt.length, 100000);
  assert.ok(OfferedTurnSchema.shape.prompt.safeParse(batch.prompt).success);

  const refused = await world.fetch(
    world.owner,
    "POST",
    "/v1/subscriptions",
    JSON.stringify({ ...subscription, prompt: `${plan}p` }),
  );
  assert.equal(refused.status, 400);
  assert.equal(ProblemSchema.parse(await refused.json()).title, "Plan and goal too long");
});
