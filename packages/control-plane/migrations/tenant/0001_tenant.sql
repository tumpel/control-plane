CREATE TABLE personas (
  persona_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  settings TEXT NOT NULL,
  mcp_servers TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
