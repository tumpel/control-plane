CREATE TABLE ci_dispatch_connections (
  connection_slot INTEGER PRIMARY KEY CHECK (connection_slot = 1),
  ci_dispatch_connection_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  caller_workflow TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE remote_buildkit_connections (
  connection_slot INTEGER PRIMARY KEY CHECK (connection_slot = 1),
  remote_buildkit_connection_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  audience TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ephemeral_vm_connections (
  connection_slot INTEGER PRIMARY KEY CHECK (connection_slot = 1),
  ephemeral_vm_connection_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  host_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
