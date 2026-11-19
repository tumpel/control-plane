CREATE TABLE host_channel_protocols (
  host_id TEXT PRIMARY KEY REFERENCES hosts (host_id),
  channel_protocol_oldest INTEGER NOT NULL CHECK (channel_protocol_oldest >= 1),
  channel_protocol_version INTEGER NOT NULL CHECK (channel_protocol_version >= channel_protocol_oldest),
  updated_at INTEGER NOT NULL
);

CREATE INDEX host_channel_protocols_by_version ON host_channel_protocols (channel_protocol_version);

CREATE TABLE host_guest_protocols (
  host_id TEXT PRIMARY KEY REFERENCES hosts (host_id),
  guest_protocol_oldest INTEGER NOT NULL CHECK (guest_protocol_oldest >= 1),
  guest_protocol_version INTEGER NOT NULL CHECK (guest_protocol_version >= guest_protocol_oldest),
  updated_at INTEGER NOT NULL
);
