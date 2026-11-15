CREATE TABLE issuer_keys_signing (
  kid TEXT PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  wrapped_data_key TEXT NOT NULL,
  private_key_sealed TEXT NOT NULL,
  signs_from INTEGER NOT NULL
);

INSERT INTO issuer_keys_signing (kid, public_jwk, wrapped_data_key, private_key_sealed, signs_from)
SELECT kid, public_jwk, wrapped_data_key, private_key_sealed, created_at FROM issuer_keys;

DROP TABLE issuer_key_retirements;

DROP TABLE issuer_keys;

ALTER TABLE issuer_keys_signing RENAME TO issuer_keys;

CREATE INDEX issuer_keys_signs_from ON issuer_keys (signs_from);
