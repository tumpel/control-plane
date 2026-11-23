DROP INDEX sessions_idle;
CREATE INDEX sessions_host_state ON sessions (host_id, state);
