CREATE TABLE host_usage (
  host_id TEXT PRIMARY KEY,
  box_capacity INTEGER NOT NULL,
  boxes_warm INTEGER NOT NULL,
  load_average REAL NOT NULL,
  memory_available_mib INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
