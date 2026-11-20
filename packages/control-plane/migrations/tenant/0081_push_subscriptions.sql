CREATE TABLE push_subscriptions (
  push_subscription_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth_sealed TEXT NOT NULL,
  cursor_event_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX push_subscriptions_principal ON push_subscriptions (principal_id, created_at, push_subscription_id);

CREATE TABLE push_subscription_events (
  push_subscription_id TEXT NOT NULL REFERENCES push_subscriptions (push_subscription_id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  PRIMARY KEY (push_subscription_id, event)
);

CREATE INDEX push_subscription_events_event ON push_subscription_events (event, push_subscription_id);
