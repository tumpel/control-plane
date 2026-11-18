CREATE TABLE IF NOT EXISTS session_placements (
  session_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  pack_digest TEXT NOT NULL,
  PRIMARY KEY (session_id, digest, pack_digest)
);
