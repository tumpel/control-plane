export const TURN_TABLES = [
  "turn_failures",
  "credential_handovers",
  "turn_metric_dimensions",
  "deferred_offers",
  "turn_results",
  "turn_full_images",
  "turn_layered_images",
  "turn_goals",
  "turn_image_fetches",
  "turn_claims",
  "subscription_pause_turns",
] as const;

export const SESSION_TABLES = [
  "transcript_pending",
  "transcript_chunks",
  "stop_failures",
  "session_chunks",
  "session_issues",
  "prebuild_sessions",
  "session_prebuild_layers",
  "session_layer_absences",
  "session_connectors",
  "session_box_memory",
  "event_sessions",
  "turns",
] as const;
