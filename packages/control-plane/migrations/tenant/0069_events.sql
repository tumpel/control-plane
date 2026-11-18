CREATE TABLE events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at INTEGER NOT NULL
);

CREATE INDEX events_created_at ON events (created_at);

CREATE TABLE event_sessions (
  event_id INTEGER PRIMARY KEY REFERENCES events (event_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL
);

CREATE INDEX event_sessions_session ON event_sessions (session_id, event_id);
