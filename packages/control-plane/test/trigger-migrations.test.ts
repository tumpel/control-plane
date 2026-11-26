import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { TriggerSchema } from "@tumpel/schemas";
import type { z } from "zod";
import { type ConditionRow, conditionRows, conditionsOf, matches } from "../src/trigger-match.ts";
import { matchedTriggers, projectRoute } from "../src/trigger-routes.ts";
import { D1Database } from "./scenarios/harness/runtime.ts";

type Trigger = z.infer<typeof TriggerSchema>;

const TENANT_MIGRATIONS = new URL("../migrations/tenant/", import.meta.url);
const CENTRAL_MIGRATIONS = new URL("../migrations/", import.meta.url);
const TENANT_ID = "tnt_migrated";

const migrationsBefore = (db: DatabaseSync, directory: URL, before: string): void => {
  for (const name of readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    if (name >= before) break;
    db.exec(readFileSync(new URL(name, directory), "utf8"));
  }
};

const migrate = (db: DatabaseSync, directory: URL, name: string): void => {
  db.exec(readFileSync(new URL(name, directory), "utf8"));
};

const trigger = (triggerId: string, event: string, conditions: Trigger["source"]["conditions"]): Trigger => ({
  triggerId,
  tenantId: TENANT_ID,
  name: triggerId,
  source: { kind: "GitHub", event: event as Trigger["source"]["event"], conditions },
  personaId: "prs_reviewer",
  model: "claude-sonnet-5-5",
  prompt: "Look at {{repository.full_name}}",
  principalId: "prn_owner",
  createdAt: 1000,
  updatedAt: 1000,
});

const TRIGGERS = [
  trigger("trg_status", "status", [
    { field: "repository.full_name", values: ["acme/app"] },
    { field: "state", values: ["success", "failure"] },
  ]),
  trigger("trg_pull_request", "pull_request", [
    { field: "action", values: ["synchronize", "closed"] },
    { field: "pull_request.number", values: ["7"] },
  ]),
  trigger("trg_push", "push", [{ field: "ref", values: ["refs/heads/main"] }]),
];

const PAYLOADS: Record<string, { event: string; payload: unknown }> = {
  trg_status: { event: "status", payload: { repository: { full_name: "acme/app" }, state: "failure" } },
  trg_pull_request: { event: "pull_request", payload: { action: "closed", pull_request: { number: 7 } } },
  trg_push: { event: "push", payload: { ref: "refs/heads/main" } },
};

const ORDER = "ORDER BY trigger_id, position, value";

const rowsOf = (db: DatabaseSync, query: string): unknown[] =>
  db
    .prepare(query)
    .all()
    .map((row) => ({ ...row }));

const tenantConditions = (db: DatabaseSync, triggerId: string): ConditionRow[] =>
  db
    .prepare("SELECT position, field, value FROM trigger_conditions WHERE trigger_id = ? ORDER BY position, value")
    .all(triggerId)
    .map((row) => ({ position: Number(row.position), field: String(row.field), value: String(row.value) }));

test("rebuilding triggers and trigger_routes keeps every condition row, and each trigger still matches its payload", async () => {
  const tenant = new DatabaseSync(":memory:");
  migrationsBefore(tenant, TENANT_MIGRATIONS, "0101");
  const central = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  migrationsBefore(central, CENTRAL_MIGRATIONS, "0029");
  central.exec("PRAGMA foreign_keys = ON");
  central
    .prepare(
      "INSERT INTO tenants (tenant_id, name, tier, created_at, updated_at) VALUES (?, 'acme', 'Configured', 1, 1)",
    )
    .run(TENANT_ID);
  const d1 = new D1Database(central) as unknown as Parameters<typeof matchedTriggers>[0];

  const insertTrigger = tenant.prepare(
    `INSERT INTO triggers (trigger_id, name, source, event, persona_id, model, prompt, principal_id, created_at, updated_at)
    VALUES (?, ?, 'GitHub', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCondition = tenant.prepare(
    "INSERT INTO trigger_conditions (trigger_id, position, field, value) VALUES (?, ?, ?, ?)",
  );
  for (const each of TRIGGERS) {
    insertTrigger.run(
      each.triggerId,
      each.name,
      each.source.event,
      each.personaId,
      each.model,
      each.prompt,
      each.principalId,
      each.createdAt,
      each.updatedAt,
    );
    for (const row of conditionRows(each.source.conditions)) {
      insertCondition.run(each.triggerId, row.position, row.field, row.value);
    }
    await projectRoute(d1, each);
  }
  const tenantBefore = rowsOf(tenant, `SELECT * FROM trigger_conditions ${ORDER}`);
  const triggersBefore = rowsOf(tenant, "SELECT * FROM triggers ORDER BY trigger_id");
  const routesBefore = rowsOf(central, "SELECT * FROM trigger_routes ORDER BY trigger_id");
  assert.equal(tenantBefore.length, 7);
  assert.deepEqual(rowsOf(central, `SELECT * FROM trigger_route_conditions ${ORDER}`), tenantBefore);

  migrate(tenant, TENANT_MIGRATIONS, "0101_trigger_session_targets.sql");
  migrate(central, CENTRAL_MIGRATIONS, "0029_trigger_route_events.sql");

  assert.deepEqual(rowsOf(tenant, `SELECT * FROM trigger_conditions ${ORDER}`), tenantBefore);
  assert.deepEqual(rowsOf(central, `SELECT * FROM trigger_route_conditions ${ORDER}`), tenantBefore);
  assert.deepEqual(rowsOf(tenant, "SELECT * FROM triggers ORDER BY trigger_id"), triggersBefore);
  assert.deepEqual(rowsOf(central, "SELECT * FROM trigger_routes ORDER BY trigger_id"), routesBefore);
  assert.deepEqual(rowsOf(tenant, "PRAGMA foreign_key_check"), []);
  assert.deepEqual(rowsOf(central, "PRAGMA foreign_key_check"), []);

  for (const each of TRIGGERS) {
    const { event, payload } = PAYLOADS[each.triggerId] ?? assert.fail(`no payload for ${each.triggerId}`);
    assert.deepEqual(await matchedTriggers(d1, TENANT_ID, "GitHub", event, payload), [each.triggerId]);
    assert.ok(matches(conditionsOf(tenantConditions(tenant, each.triggerId)), payload));
  }
});

test("after the rebuild a trigger takes the two new events, and its session target goes with the trigger", () => {
  const tenant = new DatabaseSync(":memory:");
  migrationsBefore(tenant, TENANT_MIGRATIONS, "0102");
  const central = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  migrationsBefore(central, CENTRAL_MIGRATIONS, "0030");
  central.exec("PRAGMA foreign_keys = ON");
  central.exec(
    "INSERT INTO tenants (tenant_id, name, tier, created_at, updated_at) VALUES ('tnt', 'acme', 'Configured', 1, 1)",
  );

  for (const event of ["check_suite", "pull_request_review"]) {
    tenant.exec(`INSERT INTO triggers (trigger_id, name, source, event, persona_id, model, prompt, principal_id, created_at, updated_at)
      VALUES ('trg_${event}', '${event}', 'GitHub', '${event}', 'prs', 'model', 'prompt', 'prn', 1, 1)`);
    central.exec(`INSERT INTO trigger_routes (trigger_id, tenant_id, source, event, updated_at)
      VALUES ('trg_${event}', 'tnt', 'GitHub', '${event}', 1)`);
  }
  assert.throws(
    () =>
      tenant.exec(`INSERT INTO triggers (trigger_id, name, source, event, persona_id, model, prompt, principal_id, created_at, updated_at)
        VALUES ('trg_fork', 'fork', 'GitHub', 'fork', 'prs', 'model', 'prompt', 'prn', 1, 1)`),
    /CHECK constraint failed/,
  );

  tenant.exec(`INSERT INTO sessions (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at)
    VALUES ('ses_foreman', 'prn', 'hst', 'box', 'prs', 'https://github.com/acme/app', 'ClaudeCode', '2.1.4', 'model', 'Idle', 1, '', 1, 1)`);
  assert.throws(
    () =>
      tenant.exec(
        "INSERT INTO trigger_session_targets (trigger_id, session_id) VALUES ('trg_check_suite', 'ses_gone')",
      ),
    /FOREIGN KEY constraint failed/,
  );
  tenant.exec("INSERT INTO trigger_session_targets (trigger_id, session_id) VALUES ('trg_check_suite', 'ses_foreman')");
  tenant.exec("DELETE FROM triggers WHERE trigger_id = 'trg_check_suite'");
  assert.deepEqual(rowsOf(tenant, "SELECT * FROM trigger_session_targets"), []);
});
