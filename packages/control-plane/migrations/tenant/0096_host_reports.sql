-- bulk-data-reviewed: host_id is the key of the host the report came from
CREATE TABLE host_reports (
  host_id TEXT PRIMARY KEY,
  box_capacity INTEGER NOT NULL CHECK (box_capacity > 0),
  channel_protocol INTEGER NOT NULL,
  memory_budget_mib INTEGER NOT NULL CHECK (memory_budget_mib >= 0),
  memory_held_mib INTEGER NOT NULL CHECK (memory_held_mib >= 0),
  memory_available_mib INTEGER NOT NULL CHECK (memory_available_mib >= 0),
  disk_budget_mib INTEGER NOT NULL CHECK (disk_budget_mib >= 0),
  disk_held_mib INTEGER NOT NULL CHECK (disk_held_mib >= 0),
  load_average REAL NOT NULL CHECK (load_average >= 0),
  heard_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
