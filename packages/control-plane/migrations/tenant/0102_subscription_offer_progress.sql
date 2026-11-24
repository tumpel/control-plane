ALTER TABLE subscriptions ADD COLUMN refusal_delivery_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (refusal_delivery_attempts BETWEEN 0 AND 10);
ALTER TABLE subscriptions ADD COLUMN refusal_delivery_retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN start_refusal_event_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_turns ADD COLUMN cursor_event_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_turns ADD COLUMN start_refusal_event_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_turns ADD COLUMN capacity_event_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_turns ADD COLUMN refusal_delivery INTEGER NOT NULL DEFAULT 0
  CHECK (refusal_delivery IN (0, 1));
