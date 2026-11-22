-- bulk-data-reviewed: tags holds the few tag names a session carried at the event, and steers keeps its existing prompt column
DROP TRIGGER turns_delete_owned_rows;

CREATE TRIGGER turns_delete_owned_rows BEFORE DELETE ON turns
BEGIN
  DELETE FROM turn_failures WHERE turn_id = OLD.turn_id;
  DELETE FROM credential_handovers WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_full_images WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_layered_images WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_goals WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_refusals WHERE turn_id = OLD.turn_id;
  DELETE FROM turn_warnings WHERE turn_id = OLD.turn_id;
END;

ALTER TABLE turns ADD COLUMN result_printed INTEGER NOT NULL DEFAULT 0 CHECK (result_printed IN (0, 1));
UPDATE turns SET result_printed = 1 WHERE turn_id IN (SELECT turn_id FROM turn_results);

ALTER TABLE turns ADD COLUMN offer_sent INTEGER NOT NULL DEFAULT 0 CHECK (offer_sent IN (0, 1));

DROP TABLE turn_results;
DROP TABLE deferred_offers;
DROP TABLE unreported_box_offers;
DROP TABLE turn_capacity_waits;
DROP TABLE turn_session_waits;
DROP TABLE turn_release_waits;
DROP TABLE turn_eviction_waits;
DROP TABLE after_turn_releases;
DROP TABLE box_evictions;
DROP TABLE box_eviction_blocks;
DROP TABLE turn_budget_starts;
DROP TABLE turn_image_fetches;
DROP TABLE turn_claims;
DROP TABLE turn_metric_dimensions;
DROP TABLE host_memory_usage;
DROP TABLE host_disk_usage;
DROP TABLE host_usage;
DROP TABLE pack_collection;

CREATE TABLE steers_next (
  steer_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns (turn_id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered INTEGER NOT NULL CHECK (delivered IN (0, 1))
);

INSERT INTO steers_next (steer_id, turn_id, prompt, created_at, delivered)
  SELECT steer_id, turn_id, prompt, created_at, steer_id IN (SELECT steer_id FROM steer_deliveries) FROM steers;

DROP TABLE steer_deliveries;
DROP TABLE steers;
DROP TABLE turn_steer_inboxes;
ALTER TABLE steers_next RENAME TO steers;
CREATE INDEX steers_turn ON steers (turn_id, created_at);

ALTER TABLE snapshot_requests DROP COLUMN deletions;

ALTER TABLE event_sessions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags));
UPDATE event_sessions SET tags =
  (SELECT json_group_array(tag) FROM session_tags WHERE session_tags.session_id = event_sessions.session_id);

ALTER TABLE subscription_turns ADD COLUMN composed INTEGER NOT NULL DEFAULT 0 CHECK (composed IN (0, 1));
UPDATE subscription_turns SET composed = 1 WHERE turn_id IN (SELECT turn_id FROM subscription_turn_batches);

DROP TABLE subscription_turn_batches;
DROP TABLE subscription_matches;

DROP INDEX subscriptions_expiry;
ALTER TABLE subscriptions DROP COLUMN expires_at_ms;
ALTER TABLE subscriptions DROP COLUMN crew_failures_in_a_row;
ALTER TABLE subscriptions DROP COLUMN delivery_failures_in_a_row;
