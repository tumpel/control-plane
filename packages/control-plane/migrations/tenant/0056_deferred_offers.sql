CREATE TABLE deferred_offers (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id),
  host_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
