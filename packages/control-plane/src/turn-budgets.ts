export interface TurnBudgetSql {
  exec<T extends Record<string, string | number | null>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] };
}

export const turnBudget = (sql: TurnBudgetSql, turnId: string): number => {
  const inserted = sql
    .exec(
      `INSERT INTO turn_budgets (turn_id, turn_total_budget_seconds)
    SELECT t.turn_id, COALESCE(o.turn_total_budget_seconds, p.turn_total_budget_seconds)
    FROM turns t JOIN sessions s ON s.session_id = t.session_id JOIN personas p ON p.persona_id = s.persona_id
    LEFT JOIN session_turn_budget_overrides o ON o.session_id = s.session_id
    WHERE t.turn_id = ? ON CONFLICT (turn_id) DO NOTHING RETURNING turn_id`,
      turnId,
    )
    .toArray();
  const [budget] = sql
    .exec<{ turn_total_budget_seconds: number }>(
      "SELECT turn_total_budget_seconds FROM turn_budgets WHERE turn_id = ?",
      turnId,
    )
    .toArray();
  if (budget === undefined) throw new Error(`turn ${turnId} has no running budget`);
  if (inserted.length > 0) {
    sql.exec(
      "UPDATE sessions SET turn_total_budget_seconds = ? WHERE session_id = (SELECT session_id FROM turns WHERE turn_id = ?)",
      budget.turn_total_budget_seconds,
      turnId,
    );
  }
  return budget.turn_total_budget_seconds;
};
