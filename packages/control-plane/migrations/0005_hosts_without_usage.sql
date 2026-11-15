CREATE TABLE hosts_without_usage (
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
  updated_at INTEGER NOT NULL,
  labels TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO hosts_without_usage (host_id, tenant_id, name, state, architecture, cpu_count, memory_bytes, public_key, supervisor_version, created_at, updated_at, labels)
SELECT host_id, tenant_id, name, state, architecture, cpu_count, memory_bytes, public_key, supervisor_version, created_at, updated_at, labels FROM hosts;

DROP TABLE hosts;

ALTER TABLE hosts_without_usage RENAME TO hosts;

CREATE INDEX hosts_by_tenant ON hosts (tenant_id, created_at);
