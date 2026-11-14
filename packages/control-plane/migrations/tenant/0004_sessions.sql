CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  box_id TEXT NOT NULL,
  secret_set_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  harness TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL,
  last_line_seq INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX sessions_created ON sessions (created_at);

CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (session_id),
  box_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX turns_session ON turns (session_id, created_at);

CREATE TABLE turn_failures (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id),
  session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE transcript_pending (
  session_id TEXT NOT NULL,
  line_seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, line_seq)
);

CREATE TABLE transcript_chunks (
  session_id TEXT NOT NULL,
  first_line_seq INTEGER NOT NULL,
  last_line_seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  line_seqs TEXT NOT NULL,
  offsets TEXT NOT NULL,
  PRIMARY KEY (session_id, first_line_seq)
);

CREATE INDEX transcript_chunks_last ON transcript_chunks (session_id, last_line_seq);

CREATE TABLE snapshot_requests (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  box_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  snapshot_seq INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE snapshots (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  box_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  snapshot_seq INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX snapshots_session ON snapshots (session_id, snapshot_seq);

CREATE TABLE snapshot_failures (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  snapshot_seq INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE dispatch_credentials (
  dispatch_credential_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  secret_set_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
