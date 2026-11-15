CREATE TABLE prebuild_commits (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  head_sha TEXT NOT NULL,
  rootfs_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX prebuild_commits_by_head ON prebuild_commits (head_sha);
