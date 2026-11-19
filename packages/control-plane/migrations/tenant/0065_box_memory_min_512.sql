ALTER TABLE personas ADD COLUMN box_memory_mib_next INTEGER NOT NULL DEFAULT 2048 CHECK (box_memory_mib_next BETWEEN 512 AND 65536);
UPDATE personas SET box_memory_mib_next = box_memory_mib;
ALTER TABLE personas DROP COLUMN box_memory_mib;
ALTER TABLE personas RENAME COLUMN box_memory_mib_next TO box_memory_mib;

CREATE TABLE session_box_memory (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id),
  box_memory_mib INTEGER NOT NULL CHECK (box_memory_mib BETWEEN 512 AND 65536)
);
