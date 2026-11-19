CREATE TABLE session_placements (
  session_id TEXT NOT NULL REFERENCES sessions (session_id),
  digest TEXT NOT NULL,
  pack_digest TEXT NOT NULL,
  PRIMARY KEY (session_id, digest, pack_digest)
);

CREATE INDEX session_placements_chunk ON session_placements (digest, pack_digest);

INSERT INTO session_placements (session_id, digest, pack_digest)
SELECT session_chunks.session_id, chunks.digest, chunks.pack_digest FROM session_chunks JOIN chunks USING (digest);

DROP TABLE session_chunks;
