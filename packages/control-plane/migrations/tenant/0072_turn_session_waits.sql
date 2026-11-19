CREATE TABLE turn_session_waits (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE
);

CREATE INDEX turn_session_waits_session ON turn_session_waits (session_id);

CREATE TABLE turn_budget_starts (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL
);
