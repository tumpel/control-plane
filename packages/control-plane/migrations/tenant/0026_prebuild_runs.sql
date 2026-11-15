CREATE TABLE prebuild_runs (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  run_id INTEGER NOT NULL UNIQUE,
  head_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
