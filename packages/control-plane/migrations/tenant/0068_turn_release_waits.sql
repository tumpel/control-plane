CREATE TABLE turn_release_waits (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE
);

CREATE INDEX turn_release_waits_session ON turn_release_waits (session_id);
