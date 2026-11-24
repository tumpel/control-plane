-- bulk-data-reviewed: paused_at is a fixed-width ISO timestamp, one row per subscription
CREATE INDEX events_start_signals ON events (event_id)
  WHERE json_extract(payload, '$.event') IN ('StartRefused', 'CapacityAvailable');
ALTER TABLE subscriptions ADD COLUMN starts_refused_in_a_row INTEGER NOT NULL DEFAULT 0 CHECK (starts_refused_in_a_row >= 0);
CREATE TABLE subscription_starts_refused_pauses (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  paused_at TEXT NOT NULL
);
ALTER TABLE subscription_turns ADD COLUMN last_event_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_turns ADD COLUMN wake INTEGER NOT NULL DEFAULT 0 CHECK (wake IN (0, 1));
