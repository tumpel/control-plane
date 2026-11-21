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
  DELETE FROM transcript_pending WHERE session_id = OLD.session_id;
  DELETE FROM transcript_chunks WHERE session_id = OLD.session_id;
  DELETE FROM event_sessions WHERE session_id = OLD.session_id;
END;

CREATE TABLE pack_collection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  list_cursor TEXT NOT NULL,
  failures INTEGER NOT NULL,
  retry_at INTEGER NOT NULL,
  deletions INTEGER NOT NULL
);

INSERT INTO pack_collection (singleton, list_cursor, failures, retry_at, deletions) VALUES (1, '', 0, 0, 0);
