ALTER TABLE personas ADD COLUMN box_disk_mib INTEGER NOT NULL DEFAULT 32768 CHECK (box_disk_mib BETWEEN 32768 AND 262144);
ALTER TABLE sessions ADD COLUMN box_disk_mib INTEGER NOT NULL DEFAULT 32768 CHECK (box_disk_mib BETWEEN 32768 AND 262144);

CREATE TABLE host_disk_usage (
  host_id TEXT PRIMARY KEY REFERENCES host_usage (host_id) ON DELETE CASCADE,
  disk_budget_mib INTEGER NOT NULL CHECK (disk_budget_mib >= 0),
  disk_held_mib INTEGER NOT NULL CHECK (disk_held_mib >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE turn_refusals (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  refused_at INTEGER NOT NULL
);

CREATE TABLE turn_warnings (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  warning TEXT NOT NULL CHECK (length(warning) > 0),
  created_at INTEGER NOT NULL
);
