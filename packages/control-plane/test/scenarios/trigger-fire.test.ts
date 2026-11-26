import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import { TriggerSchema } from "@tumpel/schemas";
import { INSTALLATION_ID, installApp } from "./harness/github.ts";
import { TENANT_ID, type World } from "./harness/world.ts";
import { startBox } from "./signal-fixtures.ts";
import { foremanIdle, statusTrigger, tool } from "./trigger-fixtures.ts";

const WEBHOOK_SECRET = "sessions-webhook-secret";
const CONDITION_VALUES = 4;
const CLAIM_CENTRAL_ROWS = 3 + CONDITION_VALUES;
const FIRE_TENANT_ROWS = { idle: 21, busy: 13, stopped: 21 };
const GONE_TENANT_ROWS = 10;
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
  const { world, host, foreman, arm, held, routed, refusals, rows, written } = await armed(t);
  const trigger = await arm("wake-gone");
  await host.finishes(foreman.offer);
  await world.settle();
  const archived = await world.fetch(world.owner, "POST", `/v1/sessions/${foreman.session.sessionId}/archive`);
  assert.equal(archived.status, 200, await archived.clone().text());
  const before = rows();
  assert.equal((await deliver(world, "status", status("success"))).status, 204);
  await world.settle();
  assert.deepEqual(written(before), { tenant: GONE_TENANT_ROWS, central: CLAIM_CENTRAL_ROWS });
  assert.equal(refusals(), 1);
  assert.equal(held(trigger.triggerId), 0);
  assert.equal(await routed(trigger.triggerId), false);
});

const archivedWhileSending = (world: World, sessionId: string): void => {
  const head = world.releases.head.bind(world.releases);
  const operations = world.tenantOperations() as unknown as {
    archiveSession: (input: {
      tenantId: string;
      sessionId: string;
      now: number;
    }) => Promise<{ archived: { kind: string } }>;
  };
  let archiving = false;
  world.releases.head = async (key) => {
    if (!archiving) {
      archiving = true;
      const { archived } = await operations.archiveSession({ tenantId: TENANT_ID, sessionId, now: Date.now() });
      assert.equal(archived.kind, "Archived");
    }
    return head(key);
  };
};

for (const path of ["idle", "stopped"] as const) {
  test(`an archive that lands while the send to a ${path} Foreman awaits commits no turn and deletes the trigger`, async (t) => {
    const { world, host, foreman, arm, prompts, held, routed, refusals } = await armed(t);
    const trigger = await arm(`wake-${path}-archived`);
    await host.finishes(foreman.offer);
    if (path === "stopped") await host.dropsIdleBox(foreman.offer);
    await world.settle();
    assert.equal((await world.session(foreman.session.sessionId)).state, path === "idle" ? "Idle" : "Stopped");
    archivedWhileSending(world, foreman.session.sessionId);
    assert.equal((await deliver(world, "status", status("success"))).status, 204);
    await world.settle();
    assert.equal((await world.session(foreman.session.sessionId)).state, "Archived");
    assert.deepEqual(prompts(), []);
    assert.equal(refusals(), 1);
    assert.equal(held(trigger.triggerId), 0);
    assert.equal(await routed(trigger.triggerId), false);
  });
}

test("a push during the wait wakes the Foreman through its pull_request trigger, and only the new head's status wakes it next", async (t) => {
  const { world, personaId, foreman, token, arm, prompts, held } = await armed(t);
  const sessionId = foreman.session.sessionId;
  const old = await arm("wake-old-head");
  await arm("wake-push", {
    name: "wake-push",
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
    prompt: "pull request {{pull_request.number}} was {{action}} to {{pull_request.head.sha}}",
    sessionId,
  });
  const pushed = { action: "synchronize", pull_request: { number: 7, head: { sha: "9d0a7b3" } } };
  assert.equal((await deliver(world, "pull_request", pushed)).status, 204);
  await world.settle();
  assert.deepEqual(prompts(), ["pull request 7 was synchronize to 9d0a7b3"]);
  assert.equal(held(old.triggerId), 1);

  const removed = await tool(world, token, "tumpel_trigger_delete", { triggerId: old.triggerId });
  assert.ok(removed.ok, removed.text);
  const renewed = statusTrigger("wake-new-head", personaId, sessionId);
  await arm("wake-new-head", {
    ...renewed,
    source: { ...renewed.source, conditions: [...renewed.source.conditions, { field: "sha", values: ["9d0a7b3"] }] },
  });
  assert.equal((await deliver(world, "status", status("success"))).status, 204);
  await world.settle();
  assert.equal(prompts().length, 1);
  assert.equal((await deliver(world, "status", { ...status("success"), sha: "9d0a7b3" })).status, 204);
  await world.settle();
  assert.deepEqual(prompts().slice(1), ["agent-review on 9d0a7b3 reads success"]);
});

test("a check suite, a review and a close each wake the Foreman once through their own trigger", async (t) => {
  const { world, personaId, foreman, arm, prompts, held, routed } = await armed(t);
  const sessionId = foreman.session.sessionId;
  const repository = { field: "repository.full_name", values: ["acme/app"] };
  const suite = await arm("wake-suite", {
    name: "wake-suite",
    source: {
      kind: "GitHub",
      event: "check_suite",
      conditions: [
        repository,
        { field: "action", values: ["completed"] },
        { field: "check_suite.app.slug", values: ["github-actions"] },
        { field: "check_suite.head_sha", values: [HEAD] },
      ],
    },
    personaId,
    model: "opus",
    prompt: "checks on {{check_suite.head_sha}} completed",
    sessionId,
  });
  const review = await arm("wake-review", {
    name: "wake-review",
    source: {
      kind: "GitHub",
      event: "pull_request_review",
      conditions: [
        repository,
        { field: "action", values: ["submitted"] },
        { field: "pull_request.number", values: ["7"] },
      ],
    },
    personaId,
    model: "opus",
    prompt: "review {{review.state}} on {{pull_request.number}}",
    sessionId,
  });
  const close = await arm("wake-close", {
    name: "wake-close",
    source: {
      kind: "GitHub",
      event: "pull_request",
      conditions: [
        repository,
        { field: "action", values: ["closed"] },
        { field: "pull_request.number", values: ["7"] },
      ],
    },
    personaId,
    model: "opus",
    prompt: "pull request {{pull_request.number}} was {{action}}",
    sessionId,
  });
  const queued = { action: "completed", check_suite: { app: { slug: "claude" }, head_sha: HEAD } };
  assert.equal((await deliver(world, "check_suite", queued)).status, 204);
  await world.settle();
  assert.deepEqual(prompts(), []);
  const deliveries: [string, Record<string, unknown>][] = [
    ["check_suite", { action: "completed", check_suite: { app: { slug: "github-actions" }, head_sha: HEAD } }],
    ["pull_request_review", { action: "submitted", review: { state: "approved" }, pull_request: { number: 7 } }],
    ["pull_request", { action: "closed", pull_request: { number: 7 } }],
  ];
  for (const [event, payload] of deliveries) {
    assert.equal((await deliver(world, event, payload)).status, 204);
    await world.settle();
  }
  assert.deepEqual(prompts().sort(), [
    `checks on ${HEAD} completed`,
    "pull request 7 was closed",
    "review approved on 7",
  ]);
  for (const trigger of [suite, review, close]) {
    assert.equal(held(trigger.triggerId), 0);
    assert.equal(await routed(trigger.triggerId), false);
  }
});

test("one status for fifty targets commits fifty turns and drops fifty-five routes within the subrequest limit", async (t) => {
  const { world, host, personaId, foreman, ownerCreate } = await armed(t);
  const sessions = [foreman.session.sessionId];
  for (let index = 0; index < 4; index += 1) {
    sessions.push((await startBox(world, host, personaId, `crew ${index}`, "Warm")).session.sessionId);
  }
  for (const [crew, sessionId] of sessions.entries()) {
    for (let index = 0; index < 10; index += 1) {
      const created = await ownerCreate(`wake-${crew}-${index}`, sessionId);
      assert.equal(created.status, 200, await created.clone().text());
    }
  }
  for (let index = 0; index < 5; index += 1) {
    world.db.sql.exec(
      "INSERT INTO trigger_routes (trigger_id, tenant_id, source, event, updated_at) VALUES (?, ?, 'GitHub', 'status', 1)",
      `stale-${index}`,
      TENANT_ID,
    );
  }
  const turns = (): number =>
    Number(
      world.tenantSql().exec("SELECT COUNT(*) AS held FROM turns WHERE prompt LIKE 'agent-review on %'").one().held,
    );
  const routes = (): number => Number(world.db.sql.exec("SELECT COUNT(*) AS held FROM trigger_routes").one().held);
  assert.equal(routes(), 55);

  let subrequests = 0;
  const prepare = world.db.prepare.bind(world.db);
  world.db.prepare = (query) => {
    subrequests += 1;
    return prepare(query);
  };
  const tenant = world.tenantSteps() as unknown as { handle: (request: unknown) => Promise<unknown> };
  const handle = tenant.handle.bind(tenant);
  tenant.handle = (request) => {
    subrequests += 1;
    return handle(request);
  };
  assert.equal((await deliver(world, "status", status("success"))).status, 204);
  await world.settle();
  world.db.prepare = prepare;
  tenant.handle = handle;
  assert.equal(turns(), 50);
  assert.equal(routes(), 0);
  assert.ok(subrequests <= 200, `one delivery made ${subrequests} subrequests`);
});

test("the 601st delivery in a minute answers 429, writes nothing and keeps the trigger", async (t) => {
  const { world, personaId, arm, prompts, held, routed, rows, written } = await armed(t);
  const trigger = await arm("wake-throttled");
  const refusing = await world.fetch(
    world.owner,
    "POST",
    "/v1/triggers",
    JSON.stringify({
      name: "owner-other",
      source: { kind: "GitHub", event: "status", conditions: [{ field: "context", values: ["ci/other"] }] },
      personaId,
      model: "opus",
      prompt: "look at {{target_url}}",
    }),
  );
  assert.equal(refusing.status, 200, await refusing.clone().text());
  for (let index = 0; index < 600; index += 1) {
    assert.equal((await deliver(world, "status", status("success", "ci/other"))).status, 204);
  }
  const before = rows();
  const throttled = await deliver(world, "status", status("success"));
  assert.equal(throttled.status, 429);
  await world.settle();
  assert.deepEqual(written(before), { tenant: 0, central: 0 });
  assert.deepEqual(prompts(), []);
  assert.equal(held(trigger.triggerId), 1);
  assert.equal(await routed(trigger.triggerId), true);
});
