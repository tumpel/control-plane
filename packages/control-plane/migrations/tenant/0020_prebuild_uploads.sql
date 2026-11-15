CREATE TABLE prebuild_uploads (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  layer_digest TEXT NOT NULL,
  layer_size_bytes INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

DROP TABLE namespace_connections;

CREATE TABLE namespace_connections (
  connection_slot INTEGER PRIMARY KEY CHECK (connection_slot = 1),
  namespace_connection_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
