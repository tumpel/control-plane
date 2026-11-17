ALTER TABLE github_installations ADD COLUMN account_type TEXT CHECK (account_type IN ('User', 'Organization'));
