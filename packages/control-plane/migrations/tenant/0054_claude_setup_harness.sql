ALTER TABLE claude_setups ADD COLUMN harness TEXT NOT NULL DEFAULT 'ClaudeCode';

ALTER TABLE claude_setups ADD COLUMN user_code TEXT;
