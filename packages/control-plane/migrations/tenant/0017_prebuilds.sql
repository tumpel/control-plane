CREATE TABLE prebuilds (
  prebuild_id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX prebuilds_key ON prebuilds (repository, input_digest, created_at);

CREATE TABLE prebuild_logs (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  log_url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

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
  failed_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
