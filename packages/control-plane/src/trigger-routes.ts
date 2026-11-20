import type { D1Database } from "@cloudflare/workers-types/index.ts";
import type { TriggerSchema } from "@tumpel/schemas";
import type { z } from "zod";
import { type ConditionRow, conditionRows, conditionsOf, matches } from "./trigger-match.ts";

type Trigger = z.infer<typeof TriggerSchema>;
type RouteRow = { trigger_id: string; position: number | null; field: string | null; value: string | null };

const HOLDS_VERSION =
  "EXISTS (SELECT 1 FROM trigger_routes WHERE trigger_id = ?1 AND tenant_id = ?2 AND updated_at = ?3)";

export const matchedTriggers = async (
  db: D1Database,
  tenantId: string,
  source: string,
  event: string,
  payload: unknown,
): Promise<string[]> => {
  const { results } = await db
    .prepare(
      `SELECT r.trigger_id, c.position, c.field, c.value FROM trigger_routes AS r
      LEFT JOIN trigger_route_conditions AS c ON c.trigger_id = r.trigger_id
      WHERE r.tenant_id = ? AND r.source = ? AND r.event = ? ORDER BY r.trigger_id, c.position, c.value`,
    )
    .bind(tenantId, source, event)
    .all<RouteRow>();
  const byTrigger = new Map<string, ConditionRow[]>();
  for (const { trigger_id, position, field, value } of results) {
    const rows = byTrigger.get(trigger_id) ?? [];
    byTrigger.set(trigger_id, rows);
    if (position !== null && field !== null && value !== null) rows.push({ position, field, value });
  }
  return [...byTrigger].filter(([, rows]) => matches(conditionsOf(rows), payload)).map(([triggerId]) => triggerId);
};

export const projectRoute = async (db: D1Database, trigger: Trigger): Promise<void> => {
  const { triggerId, tenantId, updatedAt } = trigger;
  await db.batch([
    db
      .prepare(
        `INSERT INTO trigger_routes (trigger_id, tenant_id, source, event, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT (trigger_id) DO UPDATE SET source = excluded.source, event = excluded.event, updated_at = excluded.updated_at
        WHERE excluded.updated_at >= trigger_routes.updated_at AND trigger_routes.tenant_id = excluded.tenant_id`,
      )
      .bind(triggerId, tenantId, trigger.source.kind, trigger.source.event, updatedAt),
    db
      .prepare(`DELETE FROM trigger_route_conditions WHERE trigger_id = ?1 AND ${HOLDS_VERSION}`)
      .bind(triggerId, tenantId, updatedAt),
    ...conditionRows(trigger.source.conditions).map((row) =>
      db
        .prepare(
          `INSERT INTO trigger_route_conditions (trigger_id, position, field, value)
          SELECT ?1, ?4, ?5, ?6 WHERE ${HOLDS_VERSION}`,
        )
        .bind(triggerId, tenantId, updatedAt, row.position, row.field, row.value),
    ),
  ]);
};

export const dropRoute = async (db: D1Database, tenantId: string, triggerId: string): Promise<void> => {
  await db.prepare("DELETE FROM trigger_routes WHERE trigger_id = ? AND tenant_id = ?").bind(triggerId, tenantId).run();
};
