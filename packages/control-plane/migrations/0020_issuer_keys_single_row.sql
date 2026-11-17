CREATE TABLE issuer_keys_single (
  key_slot INTEGER PRIMARY KEY CHECK (key_slot = 1),
  kid TEXT NOT NULL UNIQUE,
  public_jwk TEXT NOT NULL,
  wrapped_data_key TEXT NOT NULL,
  private_key_sealed TEXT NOT NULL
);

INSERT INTO issuer_keys_single (key_slot, kid, public_jwk, wrapped_data_key, private_key_sealed)
SELECT 1, kid, public_jwk, wrapped_data_key, private_key_sealed
FROM issuer_keys
ORDER BY signs_from DESC, kid DESC
LIMIT 1;

DROP TABLE issuer_keys;

ALTER TABLE issuer_keys_single RENAME TO issuer_keys;
