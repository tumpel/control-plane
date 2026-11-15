DROP TABLE invitations;

CREATE TABLE invitations (
  invitation_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  principal_id TEXT NOT NULL REFERENCES principals (principal_id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Owner', 'Member')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX invitations_by_tenant ON invitations (tenant_id, created_at);
