CREATE TABLE turn_capacity_waits (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
