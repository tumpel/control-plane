CREATE TABLE turn_image_fetches (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id),
  started_at INTEGER NOT NULL
);

CREATE TABLE turn_claims (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id),
  claimed_at INTEGER NOT NULL
);
