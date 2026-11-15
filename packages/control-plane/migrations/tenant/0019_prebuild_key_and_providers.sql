DROP TABLE prebuild_logs;
DROP TABLE prebuild_layers;
DROP TABLE prebuild_failures;
DROP TABLE prebuilds;

CREATE TABLE prebuilds (
  prebuild_id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  guest_image_digest TEXT NOT NULL,
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  log_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX prebuilds_key ON prebuilds (repository, input_digest, guest_image_digest, created_at);

CREATE TABLE prebuild_layers (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  layer_digest TEXT NOT NULL,
  layer_size_bytes INTEGER NOT NULL,
  finished_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE prebuild_failures (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  phase TEXT NOT NULL,
  detail TEXT NOT NULL,
  fix TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

DROP TABLE ephemeral_vm_connections;

ALTER TABLE ci_dispatch_connections RENAME TO github_actions_connections;
ALTER TABLE github_actions_connections RENAME COLUMN ci_dispatch_connection_id TO github_actions_connection_id;

ALTER TABLE remote_buildkit_connections RENAME TO namespace_connections;
ALTER TABLE namespace_connections RENAME COLUMN remote_buildkit_connection_id TO namespace_connection_id;
