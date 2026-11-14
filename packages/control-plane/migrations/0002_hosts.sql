DROP TABLE hosts;

CREATE TABLE hosts (
  host_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Enrolled', 'Online', 'Offline', 'Revoked')),
  architecture TEXT NOT NULL CHECK (architecture IN ('Amd64', 'Arm64')),
  cpu_count INTEGER NOT NULL,
  memory_bytes INTEGER NOT NULL,
  public_key TEXT NOT NULL,
  supervisor_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX hosts_by_tenant ON hosts (tenant_id, created_at);

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

CREATE INDEX enrolment_tokens_by_tenant ON enrolment_tokens (tenant_id, created_at);
