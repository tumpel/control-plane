CREATE TABLE turn_goals (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id),
  goal TEXT NOT NULL CHECK (length(goal) > 0),
  created_at INTEGER NOT NULL
);
