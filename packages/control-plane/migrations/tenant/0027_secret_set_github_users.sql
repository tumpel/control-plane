CREATE TABLE secret_set_github_users (
  secret_set_id TEXT PRIMARY KEY REFERENCES secret_sets (secret_set_id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
