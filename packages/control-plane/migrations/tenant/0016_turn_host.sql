ALTER TABLE turns ADD COLUMN host_id TEXT NOT NULL DEFAULT '';

UPDATE turns SET host_id = (SELECT sessions.host_id FROM sessions WHERE sessions.session_id = turns.session_id);
