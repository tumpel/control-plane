-- bulk-data-reviewed: one counter and two cursor watermarks per subscription; one pause timestamp per paused subscription
ALTER TABLE subscriptions ADD COLUMN starts_refused_in_a_row INTEGER NOT NULL DEFAULT 0 CHECK (starts_refused_in_a_row BETWEEN 0 AND 10);
ALTER TABLE subscriptions ADD COLUMN capacity_refusal_event_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN capacity_event_id INTEGER NOT NULL DEFAULT 0;
CREATE TABLE subscription_starts_refused_pauses (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  paused_at TEXT NOT NULL
);
