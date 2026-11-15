ALTER TABLE session_issues DROP COLUMN owner;
ALTER TABLE session_issues DROP COLUMN name;

UPDATE sessions
SET repository = lower(substr(repository, 1, length(repository) - 4))
WHERE session_id IN (SELECT session_id FROM session_issues) AND repository LIKE '%.git';
