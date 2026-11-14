CREATE TABLE tenants (
  tenant_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('Owner', 'Member')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX principals_by_tenant ON principals (tenant_id);

CREATE TABLE device_codes (
  device_code_sha256 TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  client_ip TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  interval_s INTEGER NOT NULL,
  last_polled_at INTEGER NOT NULL
);

CREATE INDEX device_codes_by_expiry ON device_codes (expires_at);

CREATE TABLE device_approvals (
  device_code_sha256 TEXT PRIMARY KEY REFERENCES device_codes (device_code_sha256) ON DELETE CASCADE,
  device_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  approved_at INTEGER NOT NULL
);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE INDEX devices_by_tenant ON devices (tenant_id, created_at);

CREATE TABLE hosts (
  host_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  created_at INTEGER NOT NULL
);

CREATE INDEX hosts_by_tenant ON hosts (tenant_id);

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_requests (
  request_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  state TEXT NOT NULL,
  state_sent INTEGER NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE oauth_codes (
  code_sha256 TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE oauth_tokens (
  token_sha256 TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX oauth_tokens_by_client ON oauth_tokens (client_id, expires_at);
