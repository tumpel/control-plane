CREATE TABLE stop_failures (
  stop_failure_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (session_id),
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX stop_failures_session ON stop_failures (session_id, created_at);
