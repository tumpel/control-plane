-- bulk-data-reviewed: reported_health is a two-value enum the host reports in each heartbeat
ALTER TABLE host_reports ADD COLUMN reported_health TEXT NOT NULL DEFAULT 'Healthy' CHECK (reported_health IN ('Healthy', 'RateLimited'));
ALTER TABLE turns ADD COLUMN unheld_heartbeats INTEGER NOT NULL DEFAULT 0 CHECK (unheld_heartbeats IN (0, 1));
CREATE INDEX sessions_idle ON sessions (host_id) WHERE state = 'Idle';
