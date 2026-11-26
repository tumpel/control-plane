-- bulk-data-reviewed: the rebuilt triggers and trigger_conditions keep their existing name, model, prompt and condition columns, and trigger_session_targets holds two ids per targeted trigger
CREATE TABLE triggers_next (
  trigger_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('GitHub')),
  event TEXT NOT NULL CHECK (event IN ('issues', 'pull_request', 'push', 'status', 'check_suite', 'pull_request_review')),
  persona_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE trigger_conditions_next (
  trigger_id TEXT NOT NULL REFERENCES triggers_next (trigger_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (trigger_id, position, value)
);

INSERT INTO triggers_next (trigger_id, name, source, event, persona_id, model, prompt, principal_id, created_at, updated_at)
  SELECT trigger_id, name, source, event, persona_id, model, prompt, principal_id, created_at, updated_at FROM triggers;

INSERT INTO trigger_conditions_next (trigger_id, position, field, value)
  SELECT trigger_id, position, field, value FROM trigger_conditions;

DROP TABLE trigger_conditions;
DROP TABLE triggers;
ALTER TABLE triggers_next RENAME TO triggers;
ALTER TABLE trigger_conditions_next RENAME TO trigger_conditions;

CREATE TABLE trigger_session_targets (
  trigger_id TEXT PRIMARY KEY REFERENCES triggers (trigger_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions (session_id)
);

CREATE INDEX trigger_session_targets_session ON trigger_session_targets (session_id);
