CREATE TABLE prebuild_layer_roots (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  snapshot_id TEXT NOT NULL,
  snapshot_seq INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE prebuild_layer_chunks (
  prebuild_id TEXT NOT NULL REFERENCES prebuild_layer_roots (prebuild_id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  PRIMARY KEY (prebuild_id, digest)
);

CREATE INDEX prebuild_layer_chunks_digest ON prebuild_layer_chunks (digest);

INSERT INTO prebuild_layer_roots (prebuild_id, snapshot_id, snapshot_seq, storage_key, created_at)
SELECT prebuild_sessions.prebuild_id, snapshots.snapshot_id, snapshots.snapshot_seq, snapshots.storage_key, snapshots.created_at
FROM prebuilds
JOIN prebuild_sessions USING (prebuild_id)
JOIN sessions ON sessions.session_id = prebuild_sessions.session_id
JOIN snapshots ON snapshots.session_id = prebuild_sessions.session_id
WHERE prebuilds.state = 'Done' AND sessions.state != 'Archived'
  AND snapshots.snapshot_seq = (SELECT MAX(latest.snapshot_seq) FROM snapshots AS latest WHERE latest.session_id = snapshots.session_id);

INSERT INTO prebuild_layer_chunks (prebuild_id, digest)
SELECT prebuild_layer_roots.prebuild_id, session_chunks.digest
FROM prebuild_layer_roots
JOIN prebuild_sessions USING (prebuild_id)
JOIN session_chunks ON session_chunks.session_id = prebuild_sessions.session_id;
