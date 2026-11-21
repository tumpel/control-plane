DROP TABLE turn_point;
DROP TABLE rollup;
DROP TABLE series_dimension;
DROP TABLE series;

-- bulk-data-reviewed: storage_key and digest name the R2 object that holds the window's rollups and turn points
CREATE TABLE metric_window (
  resolution TEXT NOT NULL CHECK (resolution IN ('Minute', 'Hour')),
  window_start INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  rollup_count INTEGER NOT NULL,
  turn_count INTEGER NOT NULL,
  PRIMARY KEY (resolution, window_start)
) WITHOUT ROWID;

-- bulk-data-reviewed: storage_key and digest name the R2 object that holds the series catalog
CREATE TABLE metric_catalog (
  catalog_id INTEGER PRIMARY KEY CHECK (catalog_id = 1),
  storage_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  series_count INTEGER NOT NULL
);
