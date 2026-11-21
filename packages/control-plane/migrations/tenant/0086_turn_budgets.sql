ALTER TABLE personas ADD COLUMN turn_total_budget_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (turn_total_budget_seconds BETWEEN 1 AND 86400);

CREATE TABLE session_turn_budget_overrides (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  turn_total_budget_seconds INTEGER NOT NULL CHECK (turn_total_budget_seconds BETWEEN 1 AND 86400)
);

CREATE TRIGGER persona_delete_turn_budget BEFORE DELETE ON personas
BEGIN
  INSERT INTO session_turn_budget_overrides (session_id, turn_total_budget_seconds)
  SELECT session_id, OLD.turn_total_budget_seconds FROM sessions WHERE persona_id = OLD.persona_id
  ON CONFLICT (session_id) DO NOTHING;
END;

CREATE TABLE turn_budgets (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  turn_total_budget_seconds INTEGER NOT NULL CHECK (turn_total_budget_seconds BETWEEN 1 AND 86400)
);

INSERT INTO turn_budgets (turn_id, turn_total_budget_seconds) SELECT turn_id, 3600 FROM turns;

DROP TRIGGER turns_delete_owned_rows;

CREATE TRIGGER turns_delete_owned_rows BEFORE DELETE ON turns
BEGIN
  DELETE FROM turn_failures WHERE turn_id = OLD.turn_id;
  DELETE FROM credential_handovers WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_metric_dimensions WHERE turn_id = OLD.turn_id;
  DELETE FROM deferred_offers WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_results WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_full_images WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_layered_images WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_goals WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_image_fetches WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_claims WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_refusals WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_warnings WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_eviction_waits WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_release_waits WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_session_waits WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_budgets WHERE turn_id = OLD.turn_id;
END;

DROP TABLE turn_budget_starts;
