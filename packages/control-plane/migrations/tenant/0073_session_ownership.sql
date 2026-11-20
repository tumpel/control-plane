DROP TRIGGER IF EXISTS credential_handovers_append_only_delete;

CREATE TRIGGER IF NOT EXISTS turns_delete_owned_rows BEFORE DELETE ON turns
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
  DELETE FROM turn_budget_starts WHERE turn_id = OLD.turn_id;
END;

CREATE TRIGGER IF NOT EXISTS sessions_delete_owned_rows BEFORE DELETE ON sessions
BEGIN
  DELETE FROM turns WHERE session_id = OLD.session_id;
  DELETE FROM stop_failures WHERE session_id = OLD.session_id;
  DELETE FROM session_chunks WHERE session_id = OLD.session_id;
  DELETE FROM session_issues WHERE session_id = OLD.session_id;
  DELETE FROM prebuild_sessions WHERE session_id = OLD.session_id;
  DELETE FROM session_prebuild_layers WHERE session_id = OLD.session_id;
  DELETE FROM session_layer_absences WHERE session_id = OLD.session_id;
  DELETE FROM session_connectors WHERE session_id = OLD.session_id;
  DELETE FROM session_box_memory WHERE session_id = OLD.session_id;
  DELETE FROM transcript_pending WHERE session_id = OLD.session_id;
  DELETE FROM transcript_chunks WHERE session_id = OLD.session_id;
  DELETE FROM event_sessions WHERE session_id = OLD.session_id;
END;

CREATE TRIGGER IF NOT EXISTS transcript_pending_session_insert BEFORE INSERT ON transcript_pending
WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed');
END;

CREATE TRIGGER IF NOT EXISTS transcript_pending_session_update BEFORE UPDATE OF session_id ON transcript_pending
WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed');
END;

CREATE TRIGGER IF NOT EXISTS transcript_chunks_session_insert BEFORE INSERT ON transcript_chunks
WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed');
END;

CREATE TRIGGER IF NOT EXISTS transcript_chunks_session_update BEFORE UPDATE OF session_id ON transcript_chunks
WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed');
END;

CREATE TRIGGER IF NOT EXISTS event_sessions_session_insert BEFORE INSERT ON event_sessions
WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed');
END;

CREATE TRIGGER IF NOT EXISTS event_sessions_session_update BEFORE UPDATE OF session_id ON event_sessions
WHEN NOT EXISTS (SELECT 1 FROM sessions WHERE session_id = NEW.session_id)
BEGIN
  SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed');
END;
