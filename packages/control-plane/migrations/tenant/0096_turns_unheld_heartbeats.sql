ALTER TABLE turns ADD COLUMN unheld_heartbeats INTEGER NOT NULL DEFAULT 0 CHECK (unheld_heartbeats IN (0, 1));
