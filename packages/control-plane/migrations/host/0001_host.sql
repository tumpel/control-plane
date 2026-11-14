CREATE TABLE host (
  host_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  revoked INTEGER NOT NULL CHECK (revoked IN (0, 1))
);

CREATE TABLE ledger (
  ledger_id INTEGER PRIMARY KEY CHECK (ledger_id = 1),
  received INTEGER NOT NULL,
  sent INTEGER NOT NULL,
  unacked TEXT NOT NULL
);
