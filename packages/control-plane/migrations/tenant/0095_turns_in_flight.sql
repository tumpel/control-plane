CREATE INDEX turns_in_flight ON turns (host_id, session_id) WHERE state IN ('Offered', 'Running');
