-- bulk-data-reviewed: the rebuilt trigger_routes and trigger_route_conditions keep their existing id and condition columns
CREATE TABLE trigger_routes_next (
  trigger_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
  source TEXT NOT NULL CHECK (source IN ('GitHub')),
  event TEXT NOT NULL CHECK (event IN ('issues', 'pull_request', 'push', 'status', 'check_suite', 'pull_request_review')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE trigger_route_conditions_next (
  trigger_id TEXT NOT NULL REFERENCES trigger_routes_next (trigger_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (trigger_id, position, value)
);

INSERT INTO trigger_routes_next (trigger_id, tenant_id, source, event, updated_at)
  SELECT trigger_id, tenant_id, source, event, updated_at FROM trigger_routes;

INSERT INTO trigger_route_conditions_next (trigger_id, position, field, value)
  SELECT trigger_id, position, field, value FROM trigger_route_conditions;

DROP TABLE trigger_route_conditions;
DROP TABLE trigger_routes;
ALTER TABLE trigger_routes_next RENAME TO trigger_routes;
ALTER TABLE trigger_route_conditions_next RENAME TO trigger_route_conditions;

CREATE INDEX trigger_routes_tenant_event ON trigger_routes (tenant_id, source, event);
