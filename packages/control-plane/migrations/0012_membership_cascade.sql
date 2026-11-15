CREATE TABLE devices_copy AS SELECT * FROM devices;

CREATE TABLE device_approvals_copy AS SELECT * FROM device_approvals;

CREATE TABLE enrolment_tokens_copy AS SELECT * FROM enrolment_tokens;

CREATE TABLE oauth_codes_copy AS SELECT * FROM oauth_codes;

CREATE TABLE oauth_tokens_copy AS SELECT * FROM oauth_tokens;

DROP TABLE device_approvals;

DROP TABLE devices;

DROP TABLE enrolment_tokens;

DROP TABLE oauth_codes;

DROP TABLE oauth_tokens;

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, principal_id) REFERENCES memberships (tenant_id, principal_id) ON DELETE CASCADE
);

INSERT INTO devices (device_id, token_sha256, tenant_id, principal_id, name, created_at, last_used_at)
SELECT c.device_id, c.token_sha256, c.tenant_id, c.principal_id, c.name, c.created_at, c.last_used_at FROM devices_copy c
JOIN memberships m ON m.tenant_id = c.tenant_id AND m.principal_id = c.principal_id;

CREATE INDEX devices_by_tenant ON devices (tenant_id, created_at);

CREATE INDEX devices_by_membership ON devices (tenant_id, principal_id);

CREATE TABLE device_approvals (
  device_code_sha256 TEXT PRIMARY KEY REFERENCES device_codes (device_code_sha256) ON DELETE CASCADE,
  device_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, principal_id) REFERENCES memberships (tenant_id, principal_id) ON DELETE CASCADE
);

INSERT INTO device_approvals (device_code_sha256, device_id, tenant_id, principal_id, approved_at)
SELECT c.device_code_sha256, c.device_id, c.tenant_id, c.principal_id, c.approved_at FROM device_approvals_copy c
JOIN memberships m ON m.tenant_id = c.tenant_id AND m.principal_id = c.principal_id;

CREATE INDEX device_approvals_by_membership ON device_approvals (tenant_id, principal_id);

CREATE TABLE enrolment_tokens (
  enrolment_token_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Unused', 'Spent')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, principal_id) REFERENCES memberships (tenant_id, principal_id) ON DELETE CASCADE
);

INSERT INTO enrolment_tokens (enrolment_token_id, token_sha256, tenant_id, principal_id, state, expires_at, created_at, updated_at)
SELECT c.enrolment_token_id, c.token_sha256, c.tenant_id, c.principal_id, c.state, c.expires_at, c.created_at, c.updated_at
FROM enrolment_tokens_copy c JOIN memberships m ON m.tenant_id = c.tenant_id AND m.principal_id = c.principal_id;

CREATE INDEX enrolment_tokens_by_tenant ON enrolment_tokens (tenant_id, created_at);

CREATE INDEX enrolment_tokens_by_membership ON enrolment_tokens (tenant_id, principal_id);

CREATE TABLE oauth_codes (
  code_sha256 TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, principal_id) REFERENCES memberships (tenant_id, principal_id) ON DELETE CASCADE
);

INSERT INTO oauth_codes (code_sha256, client_id, tenant_id, principal_id, redirect_uri, code_challenge, created_at, expires_at, spent)
SELECT c.code_sha256, c.client_id, c.tenant_id, c.principal_id, c.redirect_uri, c.code_challenge, c.created_at, c.expires_at, c.spent
FROM oauth_codes_copy c JOIN memberships m ON m.tenant_id = c.tenant_id AND m.principal_id = c.principal_id;

CREATE INDEX oauth_codes_by_membership ON oauth_codes (tenant_id, principal_id);

CREATE TABLE oauth_tokens (
  token_sha256 TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, principal_id) REFERENCES memberships (tenant_id, principal_id) ON DELETE CASCADE
);

INSERT INTO oauth_tokens (token_sha256, grant_id, client_id, tenant_id, principal_id, kind, created_at, expires_at, spent)
SELECT c.token_sha256, c.grant_id, c.client_id, c.tenant_id, c.principal_id, c.kind, c.created_at, c.expires_at, c.spent
FROM oauth_tokens_copy c JOIN memberships m ON m.tenant_id = c.tenant_id AND m.principal_id = c.principal_id;

CREATE INDEX oauth_tokens_by_client ON oauth_tokens (client_id, expires_at);

CREATE INDEX oauth_tokens_by_grant ON oauth_tokens (grant_id);

CREATE INDEX oauth_tokens_by_membership ON oauth_tokens (tenant_id, principal_id);

DROP TABLE devices_copy;

DROP TABLE device_approvals_copy;

DROP TABLE enrolment_tokens_copy;

DROP TABLE oauth_codes_copy;

DROP TABLE oauth_tokens_copy;
