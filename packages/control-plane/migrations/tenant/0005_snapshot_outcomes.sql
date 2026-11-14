DROP TABLE dispatch_credentials;

ALTER TABLE snapshot_failures ADD COLUMN box_id TEXT NOT NULL DEFAULT '';
ALTER TABLE snapshot_failures ADD COLUMN storage_key TEXT NOT NULL DEFAULT '';

UPDATE snapshot_failures
SET box_id = (SELECT sessions.box_id FROM sessions WHERE sessions.session_id = snapshot_failures.session_id);

CREATE INDEX snapshot_failures_session ON snapshot_failures (session_id, snapshot_seq);

CREATE INDEX snapshot_requests_turn ON snapshot_requests (session_id, turn_id);
