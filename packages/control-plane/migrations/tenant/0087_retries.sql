CREATE TABLE subscription_delivery_retries (
  subscription_id TEXT PRIMARY KEY REFERENCES subscription_actives (subscription_id) ON DELETE CASCADE,
  retry_at INTEGER NOT NULL
);

CREATE INDEX subscription_delivery_retries_due ON subscription_delivery_retries (retry_at);

CREATE TABLE webhook_wake_retries (
  webhook_endpoint_id TEXT PRIMARY KEY REFERENCES webhook_wakes (webhook_endpoint_id) ON DELETE CASCADE,
  failures INTEGER NOT NULL,
  retry_at INTEGER NOT NULL
);

CREATE INDEX webhook_wake_retries_due ON webhook_wake_retries (retry_at);

CREATE TABLE deadline_failures (
  timer TEXT NOT NULL,
  name TEXT NOT NULL,
  at INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  PRIMARY KEY (timer, name)
);
