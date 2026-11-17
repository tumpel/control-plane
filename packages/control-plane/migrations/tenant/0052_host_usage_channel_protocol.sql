CREATE TABLE host_usage_next (
  host_id TEXT PRIMARY KEY,
  box_capacity INTEGER NOT NULL,
  boxes_warm INTEGER NOT NULL,
  load_average REAL NOT NULL,
  memory_available_mib INTEGER NOT NULL,
  channel_protocol INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO host_usage_next (host_id, box_capacity, boxes_warm, load_average, memory_available_mib, channel_protocol, created_at, updated_at)
SELECT host_id, box_capacity, boxes_warm, load_average, memory_available_mib, 18, created_at, updated_at FROM host_usage;

DROP TABLE host_usage;

ALTER TABLE host_usage_next RENAME TO host_usage;
