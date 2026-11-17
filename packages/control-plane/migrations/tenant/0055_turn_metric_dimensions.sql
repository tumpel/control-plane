CREATE TABLE turn_metric_dimensions (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id),
  dimensions TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
