CREATE TABLE snapshot_manifest_chunks (
  snapshot_id TEXT NOT NULL REFERENCES snapshots (snapshot_id),
  digest TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, digest)
);

CREATE INDEX snapshot_manifest_chunks_digest ON snapshot_manifest_chunks (digest);

CREATE TABLE chunk_releases (
  digest TEXT PRIMARY KEY,
  released_at INTEGER NOT NULL
);
