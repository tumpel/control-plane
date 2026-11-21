ALTER TABLE personas ADD COLUMN turn_total_budget_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (turn_total_budget_seconds BETWEEN 1 AND 86400);
ALTER TABLE sessions ADD COLUMN turn_total_budget_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (turn_total_budget_seconds BETWEEN 1 AND 86400);
ALTER TABLE turns ADD COLUMN turn_total_budget_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (turn_total_budget_seconds BETWEEN 1 AND 86400);

ALTER TABLE turn_budget_starts RENAME TO turn_offerable_at;
ALTER TABLE turn_offerable_at RENAME COLUMN started_at TO offerable_at;
