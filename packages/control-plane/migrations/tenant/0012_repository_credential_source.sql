ALTER TABLE credential_handovers ADD COLUMN repository_credential_source TEXT NOT NULL DEFAULT 'None';

DROP TRIGGER credential_handovers_append_only_update;

UPDATE credential_handovers SET repository_credential_source = 'SecretSet'
WHERE EXISTS (SELECT 1 FROM json_each(credential_handovers.variable_names) WHERE json_each.value = 'GITHUB_TOKEN');

CREATE TRIGGER credential_handovers_append_only_update BEFORE UPDATE ON credential_handovers
BEGIN
  SELECT RAISE(ABORT, 'credential_handovers is append-only');
END;
