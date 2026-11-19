ALTER TABLE personas ADD COLUMN box_retention TEXT NOT NULL DEFAULT 'Auto' CHECK (box_retention IN ('Off', 'Warm', 'Auto'));

CREATE TABLE session_box_retention (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  box_retention TEXT NOT NULL CHECK (box_retention IN ('Off', 'Warm', 'Auto'))
);

CREATE TABLE after_turn_releases (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  box_id TEXT NOT NULL,
  started_at INTEGER NOT NULL
);

CREATE TABLE box_evictions (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  box_id TEXT NOT NULL,
  started_at INTEGER NOT NULL
);

CREATE TABLE turn_eviction_waits (
  turn_id TEXT NOT NULL REFERENCES turns (turn_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES box_evictions (session_id) ON DELETE CASCADE,
  PRIMARY KEY (turn_id, session_id)
);

CREATE INDEX turn_eviction_waits_session ON turn_eviction_waits (session_id);
