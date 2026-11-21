import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type TurnBudgetSql, turnBudget } from "../src/turn-budgets.ts";

const migrations = new URL("../migrations/tenant/", import.meta.url);

test("old rows keep an hour, new turns inherit persona edits, and session overrides win", () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const name of readdirSync(migrations).sort()) {
    if (name >= "0086") break;
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  db.exec(`INSERT INTO personas (persona_id, tenant_id, name, harness, secret_set_id, created_at, updated_at)
    VALUES ('persona', 'tenant', 'Crew', 'Codex', 'secrets', 1, 1)`);
  db.exec(`INSERT INTO sessions (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at)
    VALUES ('session', 'principal', 'host', 'box', 'persona', 'https://github.com/acme/app', 'Codex', '1', 'model', 'Running', 0, '', 1, 1)`);
  const insertTurn =
    db.prepare(`INSERT INTO turns (turn_id, session_id, host_id, box_id, prompt, state, line_count, created_at, updated_at)
    VALUES (?, 'session', 'host', 'box', 'work', 'Running', 0, 1, 20)`);
  insertTurn.run("old");
  db.exec("INSERT INTO turn_claims (turn_id, claimed_at) VALUES ('old', 10)");
  db.exec(readFileSync(new URL("0086_turn_budgets.sql", migrations), "utf8"));
  const sql: TurnBudgetSql = {
    exec: <T>(query: string, ...bindings: (string | number | null)[]) => {
      const rows = db.prepare(query).all(...bindings) as T[];
      return { toArray: () => rows };
    },
  };
  assert.equal(turnBudget(sql, "old"), 3600);
  assert.equal(db.prepare("SELECT turn_total_budget_seconds FROM sessions").get()?.turn_total_budget_seconds, 3600);
  assert.equal(db.prepare("SELECT started_at FROM turn_budget_starts WHERE turn_id = 'old'").get()?.started_at, 10);

  db.exec("UPDATE personas SET turn_total_budget_seconds = 14400");
  assert.equal(turnBudget(sql, "old"), 3600);
  insertTurn.run("next");
  assert.equal(turnBudget(sql, "next"), 14400);
  assert.equal(db.prepare("SELECT turn_total_budget_seconds FROM sessions").get()?.turn_total_budget_seconds, 14400);
  db.exec("UPDATE personas SET turn_total_budget_seconds = 7200");
  assert.equal(turnBudget(sql, "next"), 14400);
  insertTurn.run("later");
  assert.equal(turnBudget(sql, "later"), 7200);

  db.exec("INSERT INTO session_turn_budget_overrides VALUES ('session', 18000)");
  insertTurn.run("override");
  assert.equal(turnBudget(sql, "override"), 18000);
  assert.throws(() => db.exec("UPDATE personas SET turn_total_budget_seconds = 86401"), /CHECK constraint failed/);
  assert.throws(
    () => db.exec("UPDATE session_turn_budget_overrides SET turn_total_budget_seconds = 0"),
    /CHECK constraint failed/,
  );
  assert.throws(() => turnBudget(sql, "missing"), /has no running budget/);
  db.close();
});
