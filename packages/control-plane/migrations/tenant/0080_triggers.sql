CREATE TABLE triggers (
  trigger_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('GitHub')),
  event TEXT NOT NULL CHECK (event IN ('issues', 'pull_request', 'push', 'status')),
  persona_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE trigger_conditions (
  trigger_id TEXT NOT NULL REFERENCES triggers (trigger_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (trigger_id, position, value)
);

CREATE TABLE session_trigger_origins (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  trigger_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  UNIQUE (trigger_id, delivery_id)
);
