-- bulk-data-reviewed: one key per room wait or signal and one fixed-width pause timestamp per subscription
CREATE TABLE subscription_room_waits (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions (subscription_id) ON DELETE CASCADE
);
CREATE TABLE subscription_room_signals (
  subscription_id TEXT PRIMARY KEY REFERENCES subscription_room_waits (subscription_id) ON DELETE CASCADE,
  signal_event_id INTEGER NOT NULL
);
ALTER TABLE subscriptions ADD COLUMN wakes_without_progress INTEGER NOT NULL DEFAULT 0 CHECK (wakes_without_progress >= 0);
CREATE TABLE subscription_starts_refused_pauses (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  paused_at TEXT NOT NULL
);
ALTER TABLE subscription_turns ADD COLUMN last_event_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_turns ADD COLUMN wake INTEGER NOT NULL DEFAULT 0 CHECK (wake IN (0, 1));
