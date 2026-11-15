DROP TABLE circleci_authorizations;

DROP TABLE circleci_clients;

CREATE TABLE circleci_clients (
  client_slot INTEGER PRIMARY KEY CHECK (client_slot = 1),
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE circleci_authorizations (
  circleci_authorization_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  authorize_url TEXT NOT NULL,
  oauth_state TEXT NOT NULL,
  verifier_sealed TEXT NOT NULL,
  phase TEXT NOT NULL,
  phase_due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE circleci_authorization_tokens (
  circleci_authorization_id TEXT PRIMARY KEY REFERENCES circleci_authorizations (circleci_authorization_id) ON DELETE CASCADE,
  token_sealed TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  organizations TEXT NOT NULL
);

CREATE TABLE circleci_authorization_completions (
  circleci_authorization_id TEXT PRIMARY KEY REFERENCES circleci_authorizations (circleci_authorization_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL
);

CREATE TABLE circleci_authorization_failures (
  circleci_authorization_id TEXT PRIMARY KEY REFERENCES circleci_authorizations (circleci_authorization_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  ended_at INTEGER NOT NULL
);
