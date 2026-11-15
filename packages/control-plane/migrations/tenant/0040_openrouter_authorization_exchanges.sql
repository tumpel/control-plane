ALTER TABLE openrouter_authorizations DROP COLUMN return_url;

CREATE TABLE openrouter_authorization_exchanges (
  openrouter_authorization_id TEXT PRIMARY KEY REFERENCES openrouter_authorizations (openrouter_authorization_id) ON DELETE CASCADE,
  exchange_due_at INTEGER NOT NULL
);
