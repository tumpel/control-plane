CREATE TABLE secret_sets (
  secret_set_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE secret_values (
  secret_set_id TEXT NOT NULL REFERENCES secret_sets (secret_set_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (secret_set_id, name)
);

CREATE TABLE harness_pins (
  harness TEXT PRIMARY KEY,
  harness_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
