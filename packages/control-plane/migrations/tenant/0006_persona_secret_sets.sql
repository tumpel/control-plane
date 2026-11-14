CREATE TABLE secret_values_plaintext AS SELECT secret_set_id, name, provider, value, updated_at FROM secret_values;

DROP TABLE secret_values;

CREATE TABLE secret_values (
  secret_set_id TEXT NOT NULL REFERENCES secret_sets (secret_set_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  sealed TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (secret_set_id, name)
);

CREATE TABLE secret_credentials (
  secret_set_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  PRIMARY KEY (secret_set_id, name),
  FOREIGN KEY (secret_set_id, name) REFERENCES secret_values (secret_set_id, name) ON DELETE CASCADE
);

CREATE UNIQUE INDEX secret_credentials_provider ON secret_credentials (secret_set_id, provider);

CREATE TABLE secret_expiries (
  secret_set_id TEXT NOT NULL,
  name TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (secret_set_id, name),
  FOREIGN KEY (secret_set_id, name) REFERENCES secret_credentials (secret_set_id, name) ON DELETE CASCADE
);

CREATE TABLE data_keys (
  data_key_id INTEGER PRIMARY KEY CHECK (data_key_id = 1),
  wrapped TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO secret_sets (secret_set_id, name, created_at, updated_at)
SELECT lower(hex(randomblob(16))), 'Default', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE EXISTS (SELECT 1 FROM personas) AND NOT EXISTS (SELECT 1 FROM secret_sets);

CREATE TABLE personas_next (
  persona_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_set_id TEXT NOT NULL REFERENCES secret_sets (secret_set_id),
  instructions TEXT NOT NULL,
  settings TEXT NOT NULL,
  mcp_servers TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO personas_next (persona_id, tenant_id, name, secret_set_id, instructions, settings, mcp_servers, created_at, updated_at)
SELECT
  personas.persona_id,
  personas.tenant_id,
  personas.name,
  COALESCE(
    (SELECT sessions.secret_set_id FROM sessions JOIN secret_sets ON secret_sets.secret_set_id = sessions.secret_set_id
      WHERE sessions.persona_id = personas.persona_id ORDER BY sessions.created_at DESC LIMIT 1),
    (SELECT secret_set_id FROM secret_sets ORDER BY created_at, secret_set_id LIMIT 1)
  ),
  personas.instructions,
  personas.settings,
  personas.mcp_servers,
  personas.created_at,
  personas.updated_at
FROM personas;

DROP TABLE personas;

ALTER TABLE personas_next RENAME TO personas;

CREATE UNIQUE INDEX personas_name ON personas (name);

CREATE INDEX personas_secret_set ON personas (secret_set_id);

ALTER TABLE sessions DROP COLUMN secret_set_id;

CREATE TABLE credential_handovers (
  dispatch_credential_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns (turn_id),
  host_id TEXT NOT NULL,
  variable_names TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX credential_handovers_turn ON credential_handovers (turn_id, created_at);

CREATE TRIGGER credential_handovers_append_only_update BEFORE UPDATE ON credential_handovers
BEGIN
  SELECT RAISE(ABORT, 'credential_handovers is append-only');
END;

CREATE TRIGGER credential_handovers_append_only_delete BEFORE DELETE ON credential_handovers
BEGIN
  SELECT RAISE(ABORT, 'credential_handovers is append-only');
END;
