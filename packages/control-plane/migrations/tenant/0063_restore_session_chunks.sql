CREATE TABLE IF NOT EXISTS session_chunks (
  session_id TEXT NOT NULL REFERENCES sessions (session_id),
  digest TEXT NOT NULL,
  PRIMARY KEY (session_id, digest)
);

CREATE INDEX IF NOT EXISTS session_chunks_digest ON session_chunks (digest);

INSERT OR IGNORE INTO session_chunks (session_id, digest) SELECT DISTINCT session_id, digest FROM session_placements;

DROP TABLE session_placements;
