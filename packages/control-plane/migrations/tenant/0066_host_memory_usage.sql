CREATE TABLE host_memory_usage (
  host_id TEXT PRIMARY KEY REFERENCES host_usage (host_id) ON DELETE CASCADE,
  memory_budget_mib INTEGER NOT NULL CHECK (memory_budget_mib >= 0),
  memory_held_mib INTEGER NOT NULL CHECK (memory_held_mib >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE unreported_box_offers (
  box_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  box_memory_mib INTEGER NOT NULL CHECK (box_memory_mib > 0)
);

CREATE INDEX unreported_box_offers_host ON unreported_box_offers (host_id);
