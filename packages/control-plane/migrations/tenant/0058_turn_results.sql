CREATE TABLE turn_results (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id),
  created_at INTEGER NOT NULL
);
