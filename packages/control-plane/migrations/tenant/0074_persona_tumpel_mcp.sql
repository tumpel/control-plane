ALTER TABLE personas ADD COLUMN tumpel_mcp INTEGER NOT NULL DEFAULT 0 CHECK (tumpel_mcp IN (0, 1));
