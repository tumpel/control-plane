CREATE TABLE oauth_tokens_next (
  token_sha256 TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0
);

INSERT INTO oauth_tokens_next (token_sha256, grant_id, client_id, principal_id, kind, created_at, expires_at, spent)
SELECT token_sha256, client_id || ' ' || principal_id || ' ' || created_at, client_id, principal_id, kind, created_at, expires_at, spent FROM oauth_tokens;

DROP TABLE oauth_tokens;

ALTER TABLE oauth_tokens_next RENAME TO oauth_tokens;

CREATE INDEX oauth_tokens_by_client ON oauth_tokens (client_id, expires_at);

CREATE INDEX oauth_tokens_by_grant ON oauth_tokens (grant_id);

ALTER TABLE oauth_clients ADD COLUMN first_party INTEGER NOT NULL DEFAULT 0;
