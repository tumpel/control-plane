DROP TRIGGER IF EXISTS sessions_delete_owned_rows;

CREATE TRIGGER sessions_delete_owned_rows BEFORE DELETE ON sessions
BEGIN
  DELETE FROM turns WHERE session_id = OLD.session_id;
  DELETE FROM stop_failures WHERE session_id = OLD.session_id;
  DELETE FROM session_issues WHERE session_id = OLD.session_id;
  DELETE FROM prebuild_sessions WHERE session_id = OLD.session_id;
  DELETE FROM session_prebuild_layers WHERE session_id = OLD.session_id;
  DELETE FROM session_layer_absences WHERE session_id = OLD.session_id;
  DELETE FROM session_connectors WHERE session_id = OLD.session_id;
  DELETE FROM session_box_memory WHERE session_id = OLD.session_id;
  DELETE FROM event_sessions WHERE session_id = OLD.session_id;
END;

DROP TABLE transcript_pending;
DROP TABLE transcript_chunks;
