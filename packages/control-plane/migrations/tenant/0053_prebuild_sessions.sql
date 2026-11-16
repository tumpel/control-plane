CREATE TABLE prebuild_sessions (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions (session_id),
  created_at INTEGER NOT NULL
);
