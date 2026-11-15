CREATE TABLE principals_copy AS SELECT principal_id, email, created_at, updated_at FROM principals;

CREATE TABLE memberships_copy AS SELECT tenant_id, principal_id, role, created_at FROM principals;

CREATE TABLE devices_copy AS SELECT * FROM devices;

CREATE TABLE device_approvals_copy AS SELECT * FROM device_approvals;

CREATE TABLE enrolment_tokens_copy AS SELECT * FROM enrolment_tokens;

CREATE TABLE oauth_codes_copy AS
SELECT c.code_sha256, c.client_id, p.tenant_id, c.principal_id, c.redirect_uri, c.code_challenge, c.created_at, c.expires_at, c.spent
FROM oauth_codes c JOIN principals p ON p.principal_id = c.principal_id;

CREATE TABLE oauth_tokens_copy AS
SELECT t.token_sha256, t.grant_id, t.client_id, p.tenant_id, t.principal_id, t.kind, t.created_at, t.expires_at, t.spent
FROM oauth_tokens t JOIN principals p ON p.principal_id = t.principal_id;

DROP TABLE device_approvals;

DROP TABLE devices;

DROP TABLE enrolment_tokens;

DROP TABLE oauth_codes;

DROP TABLE oauth_tokens;

DROP TABLE principals;

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO principals (principal_id, email, created_at, updated_at)
SELECT principal_id, email, created_at, updated_at FROM principals_copy;

CREATE TABLE memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  role TEXT NOT NULL CHECK (role IN ('Owner', 'Member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id)
);

INSERT INTO memberships (tenant_id, principal_id, role, created_at)
SELECT tenant_id, principal_id, role, created_at FROM memberships_copy;

CREATE INDEX memberships_by_principal ON memberships (principal_id, created_at);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

INSERT INTO devices (device_id, token_sha256, tenant_id, principal_id, name, created_at, last_used_at)
SELECT device_id, token_sha256, tenant_id, principal_id, name, created_at, last_used_at FROM devices_copy;

CREATE INDEX devices_by_tenant ON devices (tenant_id, created_at);

CREATE TABLE device_approvals (
  device_code_sha256 TEXT PRIMARY KEY REFERENCES device_codes (device_code_sha256) ON DELETE CASCADE,
  device_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  approved_at INTEGER NOT NULL
);

INSERT INTO device_approvals (device_code_sha256, device_id, tenant_id, principal_id, approved_at)
SELECT device_code_sha256, device_id, tenant_id, principal_id, approved_at FROM device_approvals_copy;

CREATE TABLE enrolment_tokens (
  enrolment_token_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  state TEXT NOT NULL CHECK (state IN ('Unused', 'Spent')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO enrolment_tokens (enrolment_token_id, token_sha256, tenant_id, principal_id, state, expires_at, created_at, updated_at)
SELECT enrolment_token_id, token_sha256, tenant_id, principal_id, state, expires_at, created_at, updated_at FROM enrolment_tokens_copy;

CREATE INDEX enrolment_tokens_by_tenant ON enrolment_tokens (tenant_id, created_at);

CREATE TABLE oauth_codes (
  code_sha256 TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0
);

INSERT INTO oauth_codes (code_sha256, client_id, tenant_id, principal_id, redirect_uri, code_challenge, created_at, expires_at, spent)
SELECT code_sha256, client_id, tenant_id, principal_id, redirect_uri, code_challenge, created_at, expires_at, spent FROM oauth_codes_copy;

CREATE TABLE oauth_tokens (
  token_sha256 TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  spent INTEGER NOT NULL DEFAULT 0
);

INSERT INTO oauth_tokens (token_sha256, grant_id, client_id, tenant_id, principal_id, kind, created_at, expires_at, spent)
SELECT token_sha256, grant_id, client_id, tenant_id, principal_id, kind, created_at, expires_at, spent FROM oauth_tokens_copy;

CREATE INDEX oauth_tokens_by_client ON oauth_tokens (client_id, expires_at);

CREATE INDEX oauth_tokens_by_grant ON oauth_tokens (grant_id);

DROP TABLE principals_copy;

DROP TABLE memberships_copy;

DROP TABLE devices_copy;

DROP TABLE device_approvals_copy;

DROP TABLE enrolment_tokens_copy;

DROP TABLE oauth_codes_copy;

DROP TABLE oauth_tokens_copy;

CREATE TABLE invitations (
  invitation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Owner', 'Member')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX invitations_by_tenant ON invitations (tenant_id, created_at);
