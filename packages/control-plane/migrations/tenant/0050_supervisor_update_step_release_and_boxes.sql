DROP TABLE supervisor_update_latest_steps;

CREATE TABLE supervisor_update_latest_steps (
  host_id TEXT PRIMARY KEY,
  from_sha256 TEXT NOT NULL,
  to_sha256 TEXT NOT NULL,
  release_version TEXT NOT NULL,
  boxes_running INTEGER NOT NULL,
  phase TEXT NOT NULL,
  at TEXT NOT NULL
);
