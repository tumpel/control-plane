CREATE TABLE prebuild_upload_jobs (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  job_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
