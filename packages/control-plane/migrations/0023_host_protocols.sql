CREATE TABLE host_channel_protocols (
  host_id TEXT PRIMARY KEY REFERENCES hosts (host_id) ON DELETE CASCADE,
  channel_protocol_oldest INTEGER NOT NULL,
  channel_protocol_version INTEGER NOT NULL
);

CREATE TABLE host_guest_protocols (
  host_id TEXT PRIMARY KEY REFERENCES hosts (host_id) ON DELETE CASCADE,
  guest_protocol_oldest INTEGER NOT NULL,
  guest_protocol_version INTEGER NOT NULL
);
