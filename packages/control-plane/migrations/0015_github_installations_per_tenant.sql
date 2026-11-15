CREATE TABLE github_installations_copy AS SELECT * FROM github_installations;

DROP TABLE github_installations;

CREATE TABLE github_installations (
  installation_id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('All', 'Selected')),
  status TEXT NOT NULL CHECK (status IN ('Active', 'Suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO github_installations (installation_id, tenant_id, account_login, account_type, repository_selection, status, created_at, updated_at)
SELECT installation_id, tenant_id, account_login, 'Organization', 'Selected', 'Active', created_at, created_at FROM github_installations_copy;

DROP TABLE github_installations_copy;

CREATE INDEX github_installations_by_tenant ON github_installations (tenant_id, created_at);
