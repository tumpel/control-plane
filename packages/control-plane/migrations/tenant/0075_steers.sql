CREATE TABLE turn_steer_inboxes (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE steers (
  steer_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turn_steer_inboxes (turn_id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX steers_turn ON steers (turn_id, created_at);

CREATE TABLE steer_deliveries (
  steer_id TEXT PRIMARY KEY REFERENCES steers (steer_id) ON DELETE CASCADE,
  delivered_at INTEGER NOT NULL
);

CREATE TABLE turn_steer_settings (
  turn_id TEXT NOT NULL REFERENCES turn_steer_inboxes (turn_id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  PRIMARY KEY (turn_id, digest)
);

CREATE INDEX turn_steer_settings_digest ON turn_steer_settings (digest);
