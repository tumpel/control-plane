CREATE TABLE supervisor_update_steps (
  supervisor_update_step_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  from_sha256 TEXT NOT NULL,
  to_sha256 TEXT NOT NULL,
  phase TEXT NOT NULL,
  at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX supervisor_update_steps_host ON supervisor_update_steps (host_id, created_at);

CREATE TABLE supervisor_update_failures (
  supervisor_update_failure_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  from_sha256 TEXT NOT NULL,
  to_sha256 TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  output_tail TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX supervisor_update_failures_host ON supervisor_update_failures (host_id, created_at);
