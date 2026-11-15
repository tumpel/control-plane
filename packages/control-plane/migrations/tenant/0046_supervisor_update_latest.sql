DROP TABLE supervisor_update_steps;

DROP TABLE supervisor_update_failures;

CREATE TABLE supervisor_update_latest_steps (
  host_id TEXT PRIMARY KEY,
  from_sha256 TEXT NOT NULL,
  to_sha256 TEXT NOT NULL,
  phase TEXT NOT NULL,
  at TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE supervisor_update_latest_failures (
  host_id TEXT PRIMARY KEY,
  from_sha256 TEXT NOT NULL,
  to_sha256 TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  output_tail TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
