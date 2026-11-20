CREATE TABLE subscriptions (
  subscription_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  prompt TEXT NOT NULL CHECK (length(prompt) > 0),
  goal TEXT NOT NULL CHECK (length(goal) > 0),
  expires_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  cursor_event_id INTEGER NOT NULL,
  crew_failures_in_a_row INTEGER NOT NULL CHECK (crew_failures_in_a_row >= 0),
  delivery_failures_in_a_row INTEGER NOT NULL CHECK (delivery_failures_in_a_row >= 0),
  state TEXT NOT NULL CHECK (state IN ('Active', 'Paused', 'Ended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX subscriptions_session ON subscriptions (session_id, state);
CREATE INDEX subscriptions_state ON subscriptions (state, expires_at_ms);

CREATE TABLE subscription_events (
  subscription_id TEXT NOT NULL REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  PRIMARY KEY (subscription_id, event)
);

CREATE TABLE subscription_crew_tags (
  subscription_id TEXT NOT NULL REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (subscription_id, tag)
);

CREATE TABLE subscription_pauses (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('ByRequest', 'DeliveryFailed', 'CrewFailing')),
  paused_at TEXT NOT NULL
);

CREATE TABLE subscription_pause_messages (
  subscription_id TEXT PRIMARY KEY REFERENCES subscription_pauses (subscription_id) ON DELETE CASCADE,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500)
);

CREATE TABLE subscription_pause_turns (
  subscription_id TEXT PRIMARY KEY REFERENCES subscription_pauses (subscription_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL
);

CREATE TABLE subscription_ends (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('SessionArchived', 'SessionFailed', 'Expired', 'GoalMet')),
  ended_at TEXT NOT NULL
);

CREATE TABLE subscription_matches (
  subscription_id TEXT NOT NULL REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events (event_id) ON DELETE CASCADE,
  PRIMARY KEY (subscription_id, event_id)
);

CREATE INDEX subscription_matches_event ON subscription_matches (event_id);

CREATE TABLE subscription_turns (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions (subscription_id) ON DELETE CASCADE
);

CREATE INDEX subscription_turns_subscription ON subscription_turns (subscription_id);

CREATE TABLE subscription_turn_batches (
  turn_id TEXT PRIMARY KEY REFERENCES subscription_turns (turn_id) ON DELETE CASCADE,
  last_event_id INTEGER NOT NULL
);
