CREATE TABLE personas_next (
  persona_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  harness TEXT NOT NULL,
  secret_set_id TEXT NOT NULL REFERENCES secret_sets (secret_set_id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO personas_next (persona_id, tenant_id, name, harness, secret_set_id, created_at, updated_at)
SELECT
  personas.persona_id,
  personas.tenant_id,
  personas.name,
  COALESCE(
    (SELECT sessions.harness FROM sessions WHERE sessions.persona_id = personas.persona_id ORDER BY sessions.created_at DESC LIMIT 1),
    'ClaudeCode'
  ),
  personas.secret_set_id,
  personas.created_at,
  personas.updated_at
FROM personas;

DROP TABLE personas;

ALTER TABLE personas_next RENAME TO personas;

CREATE UNIQUE INDEX personas_name ON personas (name);

CREATE INDEX personas_secret_set ON personas (secret_set_id);

CREATE TABLE persona_files (
  persona_id TEXT NOT NULL REFERENCES personas (persona_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  digest TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (persona_id, path)
);
