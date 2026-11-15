CREATE TABLE issuer_keys (
  kid TEXT PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  wrapped_data_key TEXT NOT NULL,
  private_key_sealed TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE issuer_key_retirements (
  kid TEXT PRIMARY KEY REFERENCES issuer_keys (kid) ON DELETE CASCADE,
  retires_at INTEGER NOT NULL
);

CREATE INDEX issuer_key_retirements_retires_at ON issuer_key_retirements (retires_at);
