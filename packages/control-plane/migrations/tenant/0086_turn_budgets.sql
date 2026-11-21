ALTER TABLE personas ADD COLUMN turn_total_budget_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (turn_total_budget_seconds BETWEEN 1 AND 86400);
ALTER TABLE sessions ADD COLUMN turn_total_budget_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (turn_total_budget_seconds BETWEEN 1 AND 86400);

CREATE TABLE session_turn_budget_overrides (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  turn_total_budget_seconds INTEGER NOT NULL CHECK (turn_total_budget_seconds BETWEEN 1 AND 86400)
);

CREATE TABLE turn_budgets (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  turn_total_budget_seconds INTEGER NOT NULL CHECK (turn_total_budget_seconds BETWEEN 1 AND 86400)
);

INSERT INTO turn_budgets (turn_id, turn_total_budget_seconds) SELECT turn_id, 3600 FROM turns;

INSERT INTO turn_budget_starts (turn_id, started_at)
SELECT t.turn_id, COALESCE(c.claimed_at, (SELECT MAX(e.created_at) FROM events e JOIN event_sessions es USING (event_id)
  WHERE es.session_id = t.session_id AND json_extract(e.payload, '$.event') = 'TurnStarted' AND json_extract(e.payload, '$.turnId') = t.turn_id), t.created_at) FROM turns t LEFT JOIN turn_claims c ON c.turn_id = t.turn_id WHERE t.state = 'Running'
ON CONFLICT (turn_id) DO UPDATE SET started_at = excluded.started_at;
