-- bulk-data-reviewed: one durable caller cursor and retry deadline; fixed box/image metadata per refusal and host capacity per event
CREATE TABLE session_crew_starts (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL
);
ALTER TABLE subscriptions ADD COLUMN capacity_retry_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE room_refusals (
  event_id INTEGER PRIMARY KEY REFERENCES events (event_id) ON DELETE CASCADE,
  box_memory_mib INTEGER NOT NULL,
  box_disk_mib INTEGER NOT NULL,
  amd64 INTEGER NOT NULL CHECK (amd64 IN (0, 1)),
  arm64 INTEGER NOT NULL CHECK (arm64 IN (0, 1)),
  harness TEXT NOT NULL,
  harness_version TEXT NOT NULL
);
CREATE TABLE capacity_rooms (
  event_id INTEGER PRIMARY KEY REFERENCES events (event_id) ON DELETE CASCADE,
  memory_mib INTEGER NOT NULL,
  disk_mib INTEGER NOT NULL,
  disk_empty INTEGER NOT NULL CHECK (disk_empty IN (0, 1)),
  architecture TEXT NOT NULL CHECK (architecture IN ('Amd64', 'Arm64')),
  host_id TEXT NOT NULL
);
CREATE TABLE stranded_room_refusals (
  event_id INTEGER PRIMARY KEY REFERENCES room_refusals (event_id) ON DELETE CASCADE,
  host_id TEXT NOT NULL
);
