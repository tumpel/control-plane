CREATE TABLE connector_names (
  connector_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE static_connectors (
  connector_id TEXT PRIMARY KEY REFERENCES connector_names (connector_id) ON DELETE CASCADE,
  url TEXT NOT NULL
);

CREATE TABLE oauth_connectors (
  connector_id TEXT PRIMARY KEY REFERENCES connector_names (connector_id) ON DELETE CASCADE,
  url TEXT NOT NULL
);

CREATE TABLE static_connector_tokens (
  connector_id TEXT PRIMARY KEY REFERENCES static_connectors (connector_id) ON DELETE CASCADE,
  token_sealed TEXT NOT NULL,
  connected_at INTEGER NOT NULL
);

CREATE TABLE oauth_connector_grants (
  connector_id TEXT PRIMARY KEY REFERENCES oauth_connectors (connector_id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  bundle_sealed TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE connector_authorizations (
  connector_authorization_id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL UNIQUE REFERENCES oauth_connectors (connector_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  issuer TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  verifier_sealed TEXT NOT NULL,
  callback_due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE connector_disconnections (
  connector_id TEXT PRIMARY KEY REFERENCES connector_names (connector_id) ON DELETE CASCADE,
  disconnected_at INTEGER NOT NULL
);

CREATE TABLE connector_authorization_failures (
  connector_id TEXT PRIMARY KEY REFERENCES oauth_connectors (connector_id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('AuthorizationDenied', 'AuthorizationExpired', 'TokenExchangeFailed', 'RefreshRefused')),
  detail TEXT NOT NULL,
  failed_at INTEGER NOT NULL
);

CREATE TABLE persona_connectors (
  persona_id TEXT NOT NULL REFERENCES personas (persona_id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES connector_names (connector_id),
  PRIMARY KEY (persona_id, connector_id)
);

CREATE INDEX persona_connectors_connector ON persona_connectors (connector_id);

CREATE TABLE session_connectors (
  session_id TEXT NOT NULL REFERENCES sessions (session_id),
  connector_id TEXT NOT NULL REFERENCES connector_names (connector_id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, connector_id)
);

CREATE INDEX session_connectors_connector ON session_connectors (connector_id);
