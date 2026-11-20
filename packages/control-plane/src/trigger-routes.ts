import type { Env } from "./index.ts";
import { tenantApi } from "./tenant-api.ts";
import { type ConditionRow, conditionRows, conditionsOf, matches } from "./trigger-match.ts";

type RouteRow = { trigger_id: string; position: number | null; field: string | null; value: string | null };

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

export const syncRoutes = async (env: Env, tenantId: string): Promise<void> => {
  const { triggers } = await tenantApi(env.TENANT, tenantId).call("listTriggers", { tenantId });
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM trigger_routes WHERE tenant_id = ?").bind(tenantId),
    ...triggers.flatMap((trigger) => [
      db
        .prepare("INSERT INTO trigger_routes (trigger_id, tenant_id, source, event) VALUES (?, ?, ?, ?)")
        .bind(trigger.triggerId, tenantId, trigger.source, trigger.event),
      ...conditionRows(trigger.conditions).map((row) =>
        db
          .prepare("INSERT INTO trigger_route_conditions (trigger_id, position, field, value) VALUES (?, ?, ?, ?)")
          .bind(trigger.triggerId, row.position, row.field, row.value),
      ),
    ]),
  ]);
};
