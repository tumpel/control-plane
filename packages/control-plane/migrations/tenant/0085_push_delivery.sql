CREATE TABLE push_wakes (
  event_id INTEGER NOT NULL REFERENCES events (event_id) ON DELETE CASCADE,
  push_subscription_id TEXT NOT NULL REFERENCES push_subscriptions (push_subscription_id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, push_subscription_id)
);
