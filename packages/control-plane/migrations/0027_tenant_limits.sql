-- bulk-data-reviewed: one small JSON limits profile per tenant, written only when an Owner changes it
CREATE TABLE tenant_limits (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants (tenant_id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
