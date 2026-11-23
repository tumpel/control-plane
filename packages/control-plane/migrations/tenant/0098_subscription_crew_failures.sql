ALTER TABLE subscriptions ADD COLUMN crew_failures_in_a_row INTEGER NOT NULL DEFAULT 0 CHECK (crew_failures_in_a_row >= 0);
