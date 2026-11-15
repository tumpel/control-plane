DROP TABLE snapshot_uploads;
DROP TABLE chunks;
DELETE FROM session_chunks;

CREATE TABLE packs (
  pack_digest TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE chunks (
  digest TEXT NOT NULL,
  pack_digest TEXT NOT NULL REFERENCES packs (pack_digest),
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  PRIMARY KEY (digest, pack_digest)
);

CREATE INDEX chunks_pack ON chunks (pack_digest);

CREATE TABLE snapshot_packs (
  snapshot_id TEXT NOT NULL,
  pack_digest TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, pack_digest)
);

CREATE TABLE snapshot_chunks (
  snapshot_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  pack_digest TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, digest, pack_digest)
);
