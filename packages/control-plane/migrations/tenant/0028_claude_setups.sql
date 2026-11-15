CREATE TABLE claude_setups (
  claude_setup_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  secret_set_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  box_id TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  state TEXT NOT NULL,
  phase_due_at INTEGER NOT NULL,
  sign_in_url TEXT,
  sealed_code TEXT,
  reason TEXT,
  detail TEXT,
  expires_at TEXT,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX claude_setups_host ON claude_setups (host_id, state);
