CREATE TABLE openrouter_authorizations (
  openrouter_authorization_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  secret_set_id TEXT NOT NULL,
  return_url TEXT NOT NULL,
  key_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE openrouter_authorization_waits (
  openrouter_authorization_id TEXT PRIMARY KEY REFERENCES openrouter_authorizations (openrouter_authorization_id) ON DELETE CASCADE,
  authorize_url TEXT NOT NULL,
  verifier_sealed TEXT NOT NULL,
  callback_due_at INTEGER NOT NULL
);

CREATE TABLE openrouter_authorization_completions (
  openrouter_authorization_id TEXT PRIMARY KEY REFERENCES openrouter_authorizations (openrouter_authorization_id) ON DELETE CASCADE,
  completed_at INTEGER NOT NULL
);

CREATE TABLE openrouter_authorization_failures (
  openrouter_authorization_id TEXT PRIMARY KEY REFERENCES openrouter_authorizations (openrouter_authorization_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  failed_at INTEGER NOT NULL
);
