DROP TRIGGER credential_handovers_append_only_delete;

CREATE TRIGGER credential_handovers_append_only_delete BEFORE DELETE ON credential_handovers
WHEN NOT EXISTS (
  SELECT 1 FROM turns JOIN sessions USING (session_id)
  WHERE turns.turn_id = OLD.turn_id AND sessions.state = 'Archived'
)
BEGIN
  SELECT RAISE(ABORT, 'credential_handovers is append-only while its session is not archived');
END;
