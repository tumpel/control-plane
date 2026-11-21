CREATE TABLE push_wakes (
  event_id INTEGER NOT NULL REFERENCES event_sessions (event_id) ON DELETE CASCADE,
  push_subscription_id TEXT NOT NULL REFERENCES push_subscriptions (push_subscription_id) ON DELETE CASCADE,
  failures INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, push_subscription_id)
);
