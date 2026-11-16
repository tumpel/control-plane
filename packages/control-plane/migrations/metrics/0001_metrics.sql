CREATE TABLE metric (
  metric TEXT PRIMARY KEY,
  unit TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('Turn', 'Sample')),
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE series (
  series_id INTEGER PRIMARY KEY,
  metric TEXT NOT NULL REFERENCES metric (metric),
  dimensions TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (metric, dimensions)
);
CREATE INDEX series_seen ON series (metric, last_seen_at);

CREATE TABLE series_dimension (
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  series_id INTEGER NOT NULL REFERENCES series (series_id) ON DELETE CASCADE,
  PRIMARY KEY (dimension, value, series_id)
) WITHOUT ROWID;
CREATE INDEX series_dimension_series ON series_dimension (series_id);

CREATE TABLE rollup (
  resolution TEXT NOT NULL CHECK (resolution IN ('Minute', 'Hour')),
  series_id INTEGER NOT NULL REFERENCES series (series_id) ON DELETE CASCADE,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  sum REAL NOT NULL,
  min REAL NOT NULL,
  max REAL NOT NULL,
  histogram TEXT NOT NULL,
  PRIMARY KEY (resolution, series_id, bucket_start)
) WITHOUT ROWID;
CREATE INDEX rollup_expiry ON rollup (resolution, bucket_start);

CREATE TABLE turn_point (
  series_id INTEGER NOT NULL REFERENCES series (series_id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (series_id, at, turn_id)
) WITHOUT ROWID;
CREATE INDEX turn_point_at ON turn_point (at);
CREATE INDEX turn_point_session ON turn_point (session_id, at);
