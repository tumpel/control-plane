DROP TABLE prebuild_commits;
DROP TABLE prebuild_upload_jobs;
DROP TABLE prebuild_pipelines;
DROP TABLE prebuild_runs;
DROP TABLE prebuild_uploads;
DROP TABLE prebuild_failures;
DROP TABLE prebuild_layers;
DROP TABLE prebuilds;

CREATE TABLE prebuilds (
  prebuild_id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  guest_image_digest TEXT NOT NULL,
  provider TEXT NOT NULL,
  config_source TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  rootfs_key TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  log_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX prebuilds_key ON prebuilds (repository, input_digest, guest_image_digest, created_at);

CREATE INDEX prebuilds_by_head ON prebuilds (repository, head_sha);

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

CREATE TABLE prebuild_uploads (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  layer_digest TEXT NOT NULL,
  layer_size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE prebuild_runs (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  run_id INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE prebuild_pipelines (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  pipeline_id TEXT NOT NULL UNIQUE,
  circleci_project_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE prebuild_upload_jobs (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  job_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
