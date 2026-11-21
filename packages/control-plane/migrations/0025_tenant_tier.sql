ALTER TABLE tenants ADD COLUMN tier TEXT NOT NULL DEFAULT 'Configured' CHECK (tier IN ('Free', 'Configured'));
