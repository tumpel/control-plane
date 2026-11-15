CREATE TABLE chunks (
  digest TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE session_chunks (
  session_id TEXT NOT NULL REFERENCES sessions (session_id),
  digest TEXT NOT NULL,
  PRIMARY KEY (session_id, digest)
);

CREATE INDEX session_chunks_digest ON session_chunks (digest);

CREATE TABLE snapshot_uploads (
  snapshot_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, digest)
);
