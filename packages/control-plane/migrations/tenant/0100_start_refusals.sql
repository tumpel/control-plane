-- bulk-data-reviewed: fixed refusal-code slots per subscription; event payloads stay in the event log
CREATE TABLE subscription_start_refusals (
  subscription_id TEXT NOT NULL REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code IN ('ModelUnsupported', 'HarnessNotInCatalog', 'ImageNotReleased', 'PoolExhausted', 'NoHostAvailable', 'HostDegraded', 'HostOffline', 'NoCredential', 'CredentialExpired')),
  event_id INTEGER NOT NULL REFERENCES events (event_id) ON DELETE CASCADE,
  PRIMARY KEY (subscription_id, code)
);

CREATE INDEX subscription_start_refusals_event ON subscription_start_refusals (event_id);
