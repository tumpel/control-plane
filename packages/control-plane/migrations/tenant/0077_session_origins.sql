CREATE TABLE session_origins (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  origin_session_id TEXT NOT NULL,
  origin_turn_id TEXT NOT NULL
);
