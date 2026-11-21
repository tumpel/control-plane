CREATE TABLE box_eviction_blocks (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE
);

INSERT INTO box_eviction_blocks (session_id)
SELECT DISTINCT x.session_id
FROM stop_failures x
WHERE x.created_at >= COALESCE((SELECT MAX(t.updated_at) FROM turns t WHERE t.session_id = x.session_id), 0)
  AND NOT EXISTS (
    SELECT 1 FROM snapshots p WHERE p.session_id = x.session_id AND p.updated_at > x.created_at
  );
