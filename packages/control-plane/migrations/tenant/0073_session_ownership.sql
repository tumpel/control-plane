CREATE TABLE turns_hold AS SELECT * FROM turns;
CREATE TABLE turn_failures_hold AS SELECT * FROM turn_failures;
CREATE TABLE credential_handovers_hold AS SELECT * FROM credential_handovers;
CREATE TABLE turn_metric_dimensions_hold AS SELECT * FROM turn_metric_dimensions;
CREATE TABLE deferred_offers_hold AS SELECT * FROM deferred_offers;
CREATE TABLE turn_results_hold AS SELECT * FROM turn_results;
CREATE TABLE turn_full_images_hold AS SELECT * FROM turn_full_images;
CREATE TABLE turn_layered_images_hold AS SELECT * FROM turn_layered_images;
CREATE TABLE turn_goals_hold AS SELECT * FROM turn_goals;
CREATE TABLE turn_image_fetches_hold AS SELECT * FROM turn_image_fetches;
CREATE TABLE turn_claims_hold AS SELECT * FROM turn_claims;
CREATE TABLE turn_refusals_hold AS SELECT * FROM turn_refusals;
CREATE TABLE turn_warnings_hold AS SELECT * FROM turn_warnings;
CREATE TABLE turn_eviction_waits_hold AS SELECT * FROM turn_eviction_waits;
CREATE TABLE turn_release_waits_hold AS SELECT * FROM turn_release_waits;
CREATE TABLE turn_session_waits_hold AS SELECT * FROM turn_session_waits;
CREATE TABLE turn_budget_starts_hold AS SELECT * FROM turn_budget_starts;
CREATE TABLE stop_failures_hold AS SELECT * FROM stop_failures;
CREATE TABLE session_chunks_hold AS SELECT * FROM session_chunks;
CREATE TABLE session_issues_hold AS SELECT * FROM session_issues;
CREATE TABLE prebuild_sessions_hold AS SELECT * FROM prebuild_sessions;
CREATE TABLE session_prebuild_layers_hold AS SELECT * FROM session_prebuild_layers;
CREATE TABLE session_layer_absences_hold AS SELECT * FROM session_layer_absences;
CREATE TABLE session_connectors_hold AS SELECT * FROM session_connectors;
CREATE TABLE session_box_memory_hold AS SELECT * FROM session_box_memory;
CREATE TABLE transcript_pending_hold AS SELECT * FROM transcript_pending;
CREATE TABLE transcript_chunks_hold AS SELECT * FROM transcript_chunks;
CREATE TABLE event_sessions_hold AS SELECT * FROM event_sessions;

DROP TRIGGER credential_handovers_append_only_delete;
DROP TRIGGER credential_handovers_append_only_update;

DROP TABLE turn_failures;
DROP TABLE credential_handovers;
DROP TABLE turn_metric_dimensions;
DROP TABLE deferred_offers;
DROP TABLE turn_results;
DROP TABLE turn_full_images;
DROP TABLE turn_layered_images;
DROP TABLE turn_goals;
DROP TABLE turn_image_fetches;
DROP TABLE turn_claims;
DROP TABLE turn_refusals;
DROP TABLE turn_warnings;
DROP TABLE turn_eviction_waits;
DROP TABLE turn_release_waits;
DROP TABLE turn_session_waits;
DROP TABLE turn_budget_starts;
DROP TABLE turns;
DROP TABLE stop_failures;
DROP TABLE session_chunks;
DROP TABLE session_issues;
DROP TABLE prebuild_sessions;
DROP TABLE session_prebuild_layers;
DROP TABLE session_layer_absences;
DROP TABLE session_connectors;
DROP TABLE session_box_memory;
DROP TABLE transcript_pending;
DROP TABLE transcript_chunks;
DROP TABLE event_sessions;

CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  box_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  state TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  host_id TEXT NOT NULL DEFAULT ''
);

CREATE INDEX turns_session ON turns (session_id, created_at);

CREATE TABLE turn_failures (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE credential_handovers (
  credential_handover_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns (turn_id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  variable_names TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  repository_credential_source TEXT NOT NULL DEFAULT 'None'
);

CREATE INDEX credential_handovers_turn ON credential_handovers (turn_id, created_at);

CREATE TRIGGER credential_handovers_append_only_update BEFORE UPDATE ON credential_handovers
BEGIN
  SELECT RAISE(ABORT, 'credential_handovers is append-only');
END;

CREATE TABLE turn_metric_dimensions (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  dimensions TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE deferred_offers (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE turn_results (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE turn_full_images (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  guest_image_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE turn_layered_images (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  base_image_digest TEXT NOT NULL,
  harness_layer_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE turn_goals (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  goal TEXT NOT NULL CHECK (length(goal) > 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE turn_image_fetches (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL
);

CREATE TABLE turn_claims (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  claimed_at INTEGER NOT NULL
);

CREATE TABLE turn_refusals (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  refused_at INTEGER NOT NULL
);

CREATE TABLE turn_warnings (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  warning TEXT NOT NULL CHECK (length(warning) > 0),
  created_at INTEGER NOT NULL
);

CREATE TABLE turn_eviction_waits (
  turn_id TEXT NOT NULL REFERENCES turns (turn_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES box_evictions (session_id) ON DELETE CASCADE,
  PRIMARY KEY (turn_id, session_id)
);

CREATE INDEX turn_eviction_waits_session ON turn_eviction_waits (session_id);

CREATE TABLE turn_release_waits (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE
);

CREATE INDEX turn_release_waits_session ON turn_release_waits (session_id);

CREATE TABLE turn_session_waits (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE
);

CREATE INDEX turn_session_waits_session ON turn_session_waits (session_id);

CREATE TABLE turn_budget_starts (
  turn_id TEXT PRIMARY KEY REFERENCES turns (turn_id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL
);

CREATE TABLE stop_failures (
  stop_failure_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX stop_failures_session ON stop_failures (session_id, created_at);

CREATE TABLE session_chunks (
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  digest TEXT NOT NULL,
  PRIMARY KEY (session_id, digest)
);

CREATE INDEX session_chunks_digest ON session_chunks (digest);

CREATE TABLE session_issues (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  issue_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  html_url TEXT NOT NULL,
  branch TEXT NOT NULL
);

CREATE TABLE prebuild_sessions (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions (session_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE session_prebuild_layers (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  prebuild_id TEXT NOT NULL REFERENCES prebuild_layers (prebuild_id),
  created_at INTEGER NOT NULL
);

CREATE TABLE session_layer_absences (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('BuildsPrebuild', 'HostNotAmd64', 'NoAmd64Image', 'NoPrebuild', 'OtherGuestImage', 'NotRecorded')),
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE session_connectors (
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES connector_names (connector_id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, connector_id)
);

CREATE INDEX session_connectors_connector ON session_connectors (connector_id);

CREATE TABLE session_box_memory (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  box_memory_mib INTEGER NOT NULL CHECK (box_memory_mib BETWEEN 512 AND 65536)
);

CREATE TABLE transcript_pending (
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  line_seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, line_seq)
);

CREATE TABLE transcript_chunks (
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE,
  first_line_seq INTEGER NOT NULL,
  last_line_seq INTEGER NOT NULL,
  turn_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  line_seqs TEXT NOT NULL,
  offsets TEXT NOT NULL,
  PRIMARY KEY (session_id, first_line_seq)
);

CREATE INDEX transcript_chunks_last ON transcript_chunks (session_id, last_line_seq);

CREATE TABLE event_sessions (
  event_id INTEGER PRIMARY KEY REFERENCES events (event_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions (session_id) ON DELETE CASCADE
);

CREATE INDEX event_sessions_session ON event_sessions (session_id, event_id);

INSERT INTO turns SELECT * FROM turns_hold;
INSERT INTO turn_failures SELECT * FROM turn_failures_hold;
INSERT INTO credential_handovers SELECT * FROM credential_handovers_hold;
INSERT INTO turn_metric_dimensions SELECT * FROM turn_metric_dimensions_hold;
INSERT INTO deferred_offers SELECT * FROM deferred_offers_hold;
INSERT INTO turn_results SELECT * FROM turn_results_hold;
INSERT INTO turn_full_images SELECT * FROM turn_full_images_hold;
INSERT INTO turn_layered_images SELECT * FROM turn_layered_images_hold;
INSERT INTO turn_goals SELECT * FROM turn_goals_hold;
INSERT INTO turn_image_fetches SELECT * FROM turn_image_fetches_hold;
INSERT INTO turn_claims SELECT * FROM turn_claims_hold;
INSERT INTO turn_refusals SELECT * FROM turn_refusals_hold;
INSERT INTO turn_warnings SELECT * FROM turn_warnings_hold;
INSERT INTO turn_eviction_waits SELECT * FROM turn_eviction_waits_hold;
INSERT INTO turn_release_waits SELECT * FROM turn_release_waits_hold;
INSERT INTO turn_session_waits SELECT * FROM turn_session_waits_hold;
INSERT INTO turn_budget_starts SELECT * FROM turn_budget_starts_hold;
INSERT INTO stop_failures SELECT * FROM stop_failures_hold;
INSERT INTO session_chunks SELECT * FROM session_chunks_hold;
INSERT INTO session_issues SELECT * FROM session_issues_hold;
INSERT INTO prebuild_sessions SELECT * FROM prebuild_sessions_hold;
INSERT INTO session_prebuild_layers SELECT * FROM session_prebuild_layers_hold;
INSERT INTO session_layer_absences SELECT * FROM session_layer_absences_hold;
INSERT INTO session_connectors SELECT * FROM session_connectors_hold;
INSERT INTO session_box_memory SELECT * FROM session_box_memory_hold;
INSERT INTO transcript_pending SELECT * FROM transcript_pending_hold WHERE session_id IN (SELECT session_id FROM sessions);
INSERT INTO transcript_chunks SELECT * FROM transcript_chunks_hold WHERE session_id IN (SELECT session_id FROM sessions);
INSERT INTO event_sessions SELECT * FROM event_sessions_hold WHERE session_id IN (SELECT session_id FROM sessions);

DROP TABLE turns_hold;
DROP TABLE turn_failures_hold;
DROP TABLE credential_handovers_hold;
DROP TABLE turn_metric_dimensions_hold;
DROP TABLE deferred_offers_hold;
DROP TABLE turn_results_hold;
DROP TABLE turn_full_images_hold;
DROP TABLE turn_layered_images_hold;
DROP TABLE turn_goals_hold;
DROP TABLE turn_image_fetches_hold;
DROP TABLE turn_claims_hold;
DROP TABLE turn_refusals_hold;
DROP TABLE turn_warnings_hold;
DROP TABLE turn_eviction_waits_hold;
DROP TABLE turn_release_waits_hold;
DROP TABLE turn_session_waits_hold;
DROP TABLE turn_budget_starts_hold;
DROP TABLE stop_failures_hold;
DROP TABLE session_chunks_hold;
DROP TABLE session_issues_hold;
DROP TABLE prebuild_sessions_hold;
DROP TABLE session_prebuild_layers_hold;
DROP TABLE session_layer_absences_hold;
DROP TABLE session_connectors_hold;
DROP TABLE session_box_memory_hold;
DROP TABLE transcript_pending_hold;
DROP TABLE transcript_chunks_hold;
DROP TABLE event_sessions_hold;
