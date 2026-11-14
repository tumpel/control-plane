ALTER TABLE personas ADD COLUMN git_author_name TEXT NOT NULL DEFAULT 'Tumpel Agent';

ALTER TABLE personas ADD COLUMN git_author_email TEXT NOT NULL DEFAULT 'agent@tumpel.invalid';
