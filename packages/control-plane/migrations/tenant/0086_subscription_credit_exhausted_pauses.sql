CREATE TABLE subscription_credit_exhausted_pauses (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns (turn_id) ON DELETE CASCADE,
  paused_at TEXT NOT NULL
);
