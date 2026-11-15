CREATE TABLE circleci_clients (
  client_slot INTEGER PRIMARY KEY CHECK (client_slot = 1),
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE circleci_token_expiries (
  connection_slot INTEGER PRIMARY KEY CHECK (connection_slot = 1),
  expires_at INTEGER NOT NULL
);

CREATE TABLE circleci_authorizations (
  circleci_authorization_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  authorize_url TEXT NOT NULL,
  oauth_state TEXT NOT NULL,
  phase TEXT NOT NULL,
  phase_due_at INTEGER NOT NULL,
  verifier_sealed TEXT,
  token_sealed TEXT,
  token_expires_at INTEGER,
  organizations TEXT,
  organization_id TEXT,
  account_label TEXT,
  reason TEXT,
  detail TEXT,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
