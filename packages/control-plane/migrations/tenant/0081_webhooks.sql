CREATE TABLE webhook_endpoints (
  webhook_endpoint_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  start_event_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE webhook_endpoint_events (
  webhook_endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints (webhook_endpoint_id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  PRIMARY KEY (webhook_endpoint_id, event)
);

CREATE TABLE webhook_deliverings (
  webhook_endpoint_id TEXT PRIMARY KEY REFERENCES webhook_endpoints (webhook_endpoint_id) ON DELETE CASCADE
);

CREATE TABLE webhook_failings (
  webhook_endpoint_id TEXT PRIMARY KEY REFERENCES webhook_endpoints (webhook_endpoint_id) ON DELETE CASCADE,
  detail TEXT NOT NULL,
  failing_since TEXT NOT NULL
);

CREATE TABLE webhook_wakes (
  webhook_endpoint_id TEXT PRIMARY KEY REFERENCES webhook_endpoints (webhook_endpoint_id) ON DELETE CASCADE
);
