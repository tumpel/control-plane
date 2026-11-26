import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import { TriggerSchema } from "@tumpel/schemas";
import { INSTALLATION_ID, installApp } from "./harness/github.ts";
import { TENANT_ID, type World } from "./harness/world.ts";
import { foremanIdle, statusTrigger, tool } from "./trigger-fixtures.ts";

const WEBHOOK_SECRET = "sessions-webhook-secret";
const CONDITION_VALUES = 4;
const CLAIM_CENTRAL_ROWS = 3 + CONDITION_VALUES;
const FIRE_TENANT_ROWS = { idle: 21, busy: 13, stopped: 21 };
const HEAD = "4f1c9e2";

const deliver = (world: World, event: string, payload: Record<string, unknown>, deliveryId = randomUUID()) => {
  const body = JSON.stringify({
    installation: { id: INSTALLATION_ID },
    repository: { full_name: "acme/app", html_url: "https://github.com/acme/app" },
    ...payload,
  });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  return world.request("/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
};

const status = (state: string, context = "agent-review") => ({ context, state, sha: HEAD });

const armed = async (t: TestContext) => {
  const fixture = await foremanIdle(t);
  const { world, personaId, foreman, token } = fixture;
  await installApp(world.db, TENANT_ID, "acme");
  const arm = async (
    name: string,
    trigger: Record<string, unknown> = statusTrigger(name, personaId, foreman.session.sessionId),
  ) => {
    const created = await tool(world, token, "tumpel_trigger_create", trigger);
    assert.ok(created.ok, created.text);
    return TriggerSchema.parse(JSON.parse(created.text));
  };
  const sql = world.tenantSql();
  const prompts = (): string[] =>
    sql
      .exec(
        "SELECT prompt FROM turns WHERE session_id = ? AND prompt != 'plan the work' ORDER BY created_at",
        foreman.session.sessionId,
      )
      .toArray()
      .map((row) => String(row.prompt));
  const held = (triggerId: string): number =>
    Number(sql.exec("SELECT COUNT(*) AS held FROM triggers WHERE trigger_id = ?", triggerId).one().held);
  const routed = async (triggerId: string): Promise<boolean> =>
    (await world.db.prepare("SELECT 1 FROM trigger_routes WHERE trigger_id = ?").bind(triggerId).first()) !== null;
  const refusals = (): number =>
    Number(sql.exec("SELECT COUNT(*) AS held FROM events WHERE payload LIKE '%TriggerStartRefused%'").one().held);
  return { ...fixture, arm, prompts, held, routed, refusals };
};

const FILLED = `agent-review on ${HEAD} reads success`;

test("a matching status sends an idle Foreman exactly one turn and deletes its trigger and route", async (t) => {
  const { world, host, foreman, arm, prompts, held, routed, rows, written } = await armed(t);
  const trigger = await arm("wake-idle");
  await host.finishes(foreman.offer);
  await world.settle();
  const before = rows();
  const answered = await deliver(world, "status", status("success"));
  assert.equal(answered.status, 204);
  await world.settle();
  const counted = written(before);
  assert.deepEqual(prompts(), [FILLED]);
  assert.equal(held(trigger.triggerId), 0);
  assert.equal(await routed(trigger.triggerId), false);
  assert.equal(counted.central, CLAIM_CENTRAL_ROWS);
  assert.equal(counted.tenant, FIRE_TENANT_ROWS.idle);
});

test("a matching status queues a turn behind a busy Foreman's turn in flight", async (t) => {
  const { world, arm, prompts, held, routed, rows, written } = await armed(t);
  const trigger = await arm("wake-busy");
  const before = rows();
  assert.equal((await deliver(world, "status", status("success"))).status, 204);
  await world.settle();
  const counted = written(before);
  assert.deepEqual(prompts(), [FILLED]);
  assert.equal(held(trigger.triggerId), 0);
  assert.equal(await routed(trigger.triggerId), false);
  assert.equal(counted.central, CLAIM_CENTRAL_ROWS);
  assert.equal(counted.tenant, FIRE_TENANT_ROWS.busy);
});

test("a matching status places a stopped Foreman on a fresh box with exactly one turn", async (t) => {
  const { world, host, foreman, arm, prompts, held, routed, rows, written } = await armed(t);
  const trigger = await arm("wake-stopped");
  await host.finishes(foreman.offer);
  await host.dropsIdleBox(foreman.offer);
  await world.settle();
  assert.equal((await world.session(foreman.session.sessionId)).state, "Stopped");
  const before = rows();
  assert.equal((await deliver(world, "status", status("success"))).status, 204);
  await world.settle();
  const counted = written(before);
  assert.deepEqual(prompts(), [FILLED]);
  assert.equal(held(trigger.triggerId), 0);
  assert.equal(await routed(trigger.triggerId), false);
  assert.equal(counted.central, CLAIM_CENTRAL_ROWS);
  assert.equal(counted.tenant, FIRE_TENANT_ROWS.stopped);
});

test("two concurrent deliveries commit one turn, and a redelivery of the same delivery commits nothing", async (t) => {
  const { world, arm, prompts, held, routed } = await armed(t);
  const trigger = await arm("wake-race");
  const deliveryId = randomUUID();
  const answers = await Promise.all([
    deliver(world, "status", status("success"), deliveryId),
    deliver(world, "status", status("failure")),
  ]);
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [204, 204],
  );
  await world.settle();
  assert.equal(prompts().length, 1);
  assert.equal(held(trigger.triggerId), 0);
  assert.equal(await routed(trigger.triggerId), false);
  assert.equal((await deliver(world, "status", status("success"), deliveryId)).status, 204);
  await world.settle();
  assert.equal(prompts().length, 1);
});

test("an unrelated status leaves the trigger armed, and agent-review wakes the Foreman once", async (t) => {
  const { world, arm, prompts, held, routed } = await armed(t);
  const trigger = await arm("wake-174");
  assert.equal((await deliver(world, "status", status("success", "ci/other"))).status, 204);
  assert.equal((await deliver(world, "status", status("pending"))).status, 204);
  await world.settle();
  assert.equal(prompts().length, 0);
  assert.equal(held(trigger.triggerId), 1);
  assert.equal(await routed(trigger.triggerId), true);
  assert.equal((await deliver(world, "status", status("success"))).status, 204);
  assert.equal((await deliver(world, "status", status("failure"))).status, 204);
  await world.settle();
  assert.deepEqual(prompts(), [FILLED]);
});

test("a delivery during a drain is refused and keeps the trigger, and the next delivery after it sends the turn", async (t) => {
  const { world, personaId, foreman, arm, prompts, held, routed, refusals } = await armed(t);
  const sessionId = foreman.session.sessionId;
  const closed = await arm("wake-closed", {
    name: "wake-closed",
    source: {
      kind: "GitHub",
      event: "pull_request",
      conditions: [
        { field: "repository.full_name", values: ["acme/app"] },
        { field: "action", values: ["synchronize", "closed"] },
        { field: "pull_request.number", values: ["7"] },
      ],
    },
    personaId,
    model: "opus",
    prompt: "pull request {{pull_request.number}} was {{action}}",
    sessionId,
  });
  const reviewed = await arm("wake-review", {
    name: "wake-review",
    source: {
      kind: "GitHub",
      event: "pull_request_review",
      conditions: [
        { field: "repository.full_name", values: ["acme/app"] },
        { field: "action", values: ["submitted"] },
        { field: "pull_request.number", values: ["7"] },
      ],
    },
    personaId,
    model: "opus",
    prompt: "review {{review.state}} on {{pull_request.number}}",
    sessionId,
  });
  await world.releases.put("deploy-drain.json", JSON.stringify({ drainToken: "drain" }));
  assert.equal((await deliver(world, "pull_request", { action: "closed", pull_request: { number: 7 } })).status, 204);
  assert.equal(
    (
      await deliver(world, "pull_request_review", {
        action: "submitted",
        review: { state: "approved" },
        pull_request: { number: 7 },
      })
    ).status,
    204,
  );
  await world.settle();
  assert.equal(prompts().length, 0);
  assert.equal(refusals(), 2);
  for (const trigger of [closed, reviewed]) {
    assert.equal(held(trigger.triggerId), 1);
    assert.equal(await routed(trigger.triggerId), true);
  }
  await world.releases.delete("deploy-drain.json");
  await world.settle();
  assert.equal(prompts().length, 0);
  assert.equal(
    (await deliver(world, "pull_request", { action: "synchronize", pull_request: { number: 7 } })).status,
    204,
  );
  await world.settle();
  assert.deepEqual(prompts(), ["pull request 7 was synchronize"]);
  assert.equal(held(closed.triggerId), 0);
  assert.equal(await routed(closed.triggerId), false);
});

test("a delivery for an archived Foreman records the refusal and deletes the trigger and its route", async (t) => {
  const { world, host, foreman, arm, held, routed, refusals } = await armed(t);
  const trigger = await arm("wake-gone");
  await host.finishes(foreman.offer);
  await world.settle();
  const archived = await world.fetch(world.owner, "POST", `/v1/sessions/${foreman.session.sessionId}/archive`);
  assert.equal(archived.status, 200, await archived.clone().text());
  assert.equal((await deliver(world, "status", status("success"))).status, 204);
  await world.settle();
  assert.equal(refusals(), 1);
  assert.equal(held(trigger.triggerId), 0);
  assert.equal(await routed(trigger.triggerId), false);
});
