UPDATE claude_setups
SET state = 'Failed',
  reason = 'Superseded',
  detail = 'a newer Claude setup of secret set ' || secret_set_id || ' started, and a secret set runs one setup at a time; follow the newest setup of the set',
  sealed_code = NULL,
  ended_at = updated_at
WHERE state IN ('Starting', 'AwaitingCode', 'Minting')
  AND EXISTS (
    SELECT 1 FROM claude_setups AS newer
    WHERE newer.secret_set_id = claude_setups.secret_set_id
      AND newer.state IN ('Starting', 'AwaitingCode', 'Minting')
      AND (newer.created_at > claude_setups.created_at
        OR (newer.created_at = claude_setups.created_at AND newer.claude_setup_id > claude_setups.claude_setup_id))
  );

CREATE UNIQUE INDEX claude_setups_running ON claude_setups (secret_set_id)
WHERE state IN ('Starting', 'AwaitingCode', 'Minting');
