-- bulk-data-reviewed: fixed refusal-code slots and one box-requirement record per subscription; event payloads stay in the event log
CREATE TABLE subscription_start_refusals (
  subscription_id TEXT NOT NULL REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code IN ('ModelUnsupported', 'HarnessNotInCatalog', 'ImageNotReleased', 'PoolExhausted', 'NoHostAvailable', 'HostDegraded', 'HostOffline', 'NoCredential', 'CredentialExpired')),
  event_id INTEGER NOT NULL REFERENCES events (event_id) ON DELETE CASCADE,
  PRIMARY KEY (subscription_id, code)
);

CREATE INDEX subscription_start_refusals_event ON subscription_start_refusals (event_id);

CREATE TABLE subscription_pending_room (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions (subscription_id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (code IN ('PoolExhausted', 'NoHostAvailable', 'HostDegraded', 'HostOffline')),
  persona_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  box_memory_mib INTEGER NOT NULL CHECK (box_memory_mib > 0),
  box_disk_mib INTEGER NOT NULL CHECK (box_disk_mib > 0),
  updated_at INTEGER NOT NULL
);
