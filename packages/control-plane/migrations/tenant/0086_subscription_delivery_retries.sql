CREATE TABLE subscription_delivery_retries (
  subscription_id TEXT PRIMARY KEY REFERENCES subscription_actives (subscription_id) ON DELETE CASCADE,
  retry_at INTEGER NOT NULL
);

CREATE INDEX subscription_delivery_retries_due ON subscription_delivery_retries (retry_at);
