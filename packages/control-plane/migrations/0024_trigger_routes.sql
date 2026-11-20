CREATE TABLE trigger_routes (
  trigger_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  source TEXT NOT NULL CHECK (source IN ('GitHub')),
  event TEXT NOT NULL CHECK (event IN ('issues', 'pull_request', 'push', 'status'))
);

CREATE INDEX trigger_routes_tenant_event ON trigger_routes (tenant_id, source, event);

CREATE TABLE trigger_route_conditions (
  trigger_id TEXT NOT NULL REFERENCES trigger_routes (trigger_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (trigger_id, position, value)
);
