CREATE TABLE session_tags (
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 63 AND tag GLOB '[a-z0-9]*' AND tag NOT GLOB '*[^a-z0-9:._-]*'),
  PRIMARY KEY (session_id, tag)
);

CREATE INDEX session_tags_tag ON session_tags (tag, session_id);
