import tenant0001 from "../migrations/tenant/0001_tenant.sql";
import tenant0002 from "../migrations/tenant/0002_config.sql";
import tenant0003 from "../migrations/tenant/0003_unique_persona_name.sql";
import tenant0004 from "../migrations/tenant/0004_sessions.sql";
import tenant0005 from "../migrations/tenant/0005_snapshot_outcomes.sql";
import tenant0006 from "../migrations/tenant/0006_persona_secret_sets.sql";
import tenant0007 from "../migrations/tenant/0007_persona_files.sql";
import tenant0008 from "../migrations/tenant/0008_persona_git_identity.sql";
import tenant0009 from "../migrations/tenant/0009_stop_failures.sql";
import tenant0010 from "../migrations/tenant/0010_persona_git_identity_required.sql";
import tenant0011 from "../migrations/tenant/0011_credential_handover_id.sql";
import tenant0012 from "../migrations/tenant/0012_repository_credential_source.sql";
import tenant0013 from "../migrations/tenant/0013_snapshot_chunks.sql";
import tenant0014 from "../migrations/tenant/0014_host_usage.sql";
import tenant0015 from "../migrations/tenant/0015_snapshot_packs.sql";
import tenant0016 from "../migrations/tenant/0016_turn_host.sql";
import tenant0017 from "../migrations/tenant/0017_prebuilds.sql";
import tenant0018 from "../migrations/tenant/0018_build_connections.sql";
import tenant0019 from "../migrations/tenant/0019_prebuild_key_and_providers.sql";
import tenant0020 from "../migrations/tenant/0020_prebuild_uploads.sql";
import tenant0021 from "../migrations/tenant/0021_session_issues.sql";
import tenant0022 from "../migrations/tenant/0022_prebuild_default_branch.sql";
import tenant0023 from "../migrations/tenant/0023_namespace_audience_defined.sql";
import tenant0024 from "../migrations/tenant/0024_session_issue_keys.sql";
import tenant0025 from "../migrations/tenant/0025_derived_git_identity.sql";
import tenant0026 from "../migrations/tenant/0026_prebuild_runs.sql";
import tenant0027 from "../migrations/tenant/0027_secret_set_github_users.sql";
import tenant0028 from "../migrations/tenant/0028_claude_setups.sql";
import tenant0029 from "../migrations/tenant/0029_circleci.sql";
import tenant0030 from "../migrations/tenant/0030_prebuild_pipelines.sql";
import tenant0031 from "../migrations/tenant/0031_prebuild_upload_jobs.sql";
import tenant0032 from "../migrations/tenant/0032_prebuild_pipeline_projects.sql";
import tenant0033 from "../migrations/tenant/0033_circleci_authorizations.sql";
import tenant0034 from "../migrations/tenant/0034_one_running_claude_setup.sql";
import tenant0035 from "../migrations/tenant/0035_circleci_authorization_phases.sql";
import tenant0036 from "../migrations/tenant/0036_github_accounts.sql";
import tenant0037 from "../migrations/tenant/0037_openrouter_authorizations.sql";
import tenant0038 from "../migrations/tenant/0038_github_account_readings.sql";
import tenant0039 from "../migrations/tenant/0039_claude_setup_reports.sql";
import tenant0040 from "../migrations/tenant/0040_openrouter_authorization_exchanges.sql";
import tenant0041 from "../migrations/tenant/0041_prebuild_config_source.sql";
import tenant0042 from "../migrations/tenant/0042_drop_claude_setup_reports.sql";
import tenant0043 from "../migrations/tenant/0043_supervisor_updates.sql";
import tenant0044 from "../migrations/tenant/0044_prebuild_commits.sql";
import tenant0045 from "../migrations/tenant/0045_prebuild_default_commands.sql";
import tenant0046 from "../migrations/tenant/0046_supervisor_update_latest.sql";
import tenant0047 from "../migrations/tenant/0047_drop_prebuild_default_commands.sql";
import tenant0048 from "../migrations/tenant/0048_prebuild_head_sha.sql";
import tenant0049 from "../migrations/tenant/0049_supervisor_update_latest_without_updated_at.sql";
import tenant0050 from "../migrations/tenant/0050_supervisor_update_step_release_and_boxes.sql";
import tenant0051 from "../migrations/tenant/0051_drop_unused_github_tables.sql";
import tenant0052 from "../migrations/tenant/0052_host_usage_channel_protocol.sql";
import tenant0053 from "../migrations/tenant/0053_prebuild_sessions.sql";
import tenant0054 from "../migrations/tenant/0054_claude_setup_harness.sql";
import tenant0055 from "../migrations/tenant/0055_turn_metric_dimensions.sql";
import tenant0056 from "../migrations/tenant/0056_deferred_offers.sql";
import tenant0057 from "../migrations/tenant/0057_persona_box_memory.sql";
import tenant0058 from "../migrations/tenant/0058_turn_results.sql";
import tenant0059 from "../migrations/tenant/0059_turn_images_and_session_layers.sql";
import tenant0060 from "../migrations/tenant/0060_turn_goals.sql";
import tenant0061 from "../migrations/tenant/0061_box_disk.sql";
import tenant0062 from "../migrations/tenant/0062_session_placements.sql";
import tenant0063 from "../migrations/tenant/0063_restore_session_chunks.sql";
import tenant0064 from "../migrations/tenant/0064_connectors.sql";
import tenant0065 from "../migrations/tenant/0065_box_memory_min_512.sql";
import tenant0066 from "../migrations/tenant/0066_host_memory_usage.sql";
import tenant0067 from "../migrations/tenant/0067_box_retention.sql";
import tenant0068 from "../migrations/tenant/0068_turn_release_waits.sql";
import tenant0069 from "../migrations/tenant/0069_events.sql";
import tenant0070 from "../migrations/tenant/0070_snapshot_manifest_chunks.sql";
import tenant0071 from "../migrations/tenant/0071_turn_timing_starts.sql";
import tenant0072 from "../migrations/tenant/0072_turn_session_waits.sql";
import tenant0073 from "../migrations/tenant/0073_session_ownership.sql";
import tenant0074 from "../migrations/tenant/0074_persona_tumpel_mcp.sql";
import tenant0075 from "../migrations/tenant/0075_steers.sql";
import tenant0076 from "../migrations/tenant/0076_session_tags.sql";
import tenant0077 from "../migrations/tenant/0077_session_origins.sql";
import tenant0078 from "../migrations/tenant/0078_subscriptions.sql";
import tenant0079 from "../migrations/tenant/0079_object_cleanups.sql";
import tenant0080 from "../migrations/tenant/0080_triggers.sql";
import tenant0081 from "../migrations/tenant/0081_webhooks.sql";
import tenant0082 from "../migrations/tenant/0082_box_eviction_blocks.sql";
import tenant0083 from "../migrations/tenant/0083_turn_capacity_waits.sql";
import tenant0084 from "../migrations/tenant/0084_push_subscriptions.sql";
import tenant0085 from "../migrations/tenant/0085_push_delivery.sql";
import tenant0087 from "../migrations/tenant/0087_retries.sql";
import tenant0088_1 from "../migrations/tenant/0088_1_drop_chunk_releases.sql";
import tenant0088_2 from "../migrations/tenant/0088_2_drop_snapshot_packs.sql";
import tenant0088_3 from "../migrations/tenant/0088_3_drop_session_chunks.sql";
import tenant0088_4 from "../migrations/tenant/0088_4_drop_chunks.sql";
import tenant0088_5 from "../migrations/tenant/0088_5_drop_packs.sql";
import tenant0088_6 from "../migrations/tenant/0088_6_drop_snapshot_manifest_chunks.sql";
import tenant0088_7 from "../migrations/tenant/0088_7_drop_snapshot_chunks.sql";
import tenant0088 from "../migrations/tenant/0088_chunk_lists_in_object_storage.sql";
import tenant0089 from "../migrations/tenant/0089_drop_alarm_bookkeeping.sql";
import tenant0090 from "../migrations/tenant/0090_drop_bookkeeping.sql";
import tenant0091 from "../migrations/tenant/0091_drop_transcript_tables.sql";
import tenant0092 from "../migrations/tenant/0092_drop_ci_prebuilds.sql";
import tenant0093 from "../migrations/tenant/0093_drop_build_providers.sql";
import tenant0094 from "../migrations/tenant/0094_turns_offered.sql";
import tenant0095 from "../migrations/tenant/0095_turns_in_flight.sql";
import tenant0096 from "../migrations/tenant/0096_host_reports.sql";
import tenant0097 from "../migrations/tenant/0097_reconcile_holdings.sql";
import tenant0098 from "../migrations/tenant/0098_subscription_failures.sql";
import tenant0099 from "../migrations/tenant/0099_sessions_host_state.sql";
import tenant0100 from "../migrations/tenant/0100_start_refusals.sql";
import type { Migration } from "./durable-migrate";

export const TENANT_MIGRATIONS: readonly Migration[] = [
  { name: "0001_tenant", sql: tenant0001 },
  { name: "0002_config", sql: tenant0002 },
  { name: "0003_unique_persona_name", sql: tenant0003 },
  { name: "0004_sessions", sql: tenant0004 },
  { name: "0005_snapshot_outcomes", sql: tenant0005 },
  { name: "0006_persona_secret_sets", sql: tenant0006 },
  { name: "0007_persona_files", sql: tenant0007 },
  { name: "0008_persona_git_identity", sql: tenant0008 },
  { name: "0009_stop_failures", sql: tenant0009 },
  { name: "0010_persona_git_identity_required", sql: tenant0010 },
  { name: "0011_credential_handover_id", sql: tenant0011 },
  { name: "0012_repository_credential_source", sql: tenant0012 },
  { name: "0013_snapshot_chunks", sql: tenant0013 },
  { name: "0014_host_usage", sql: tenant0014 },
  { name: "0015_snapshot_packs", sql: tenant0015 },
  { name: "0016_turn_host", sql: tenant0016 },
  { name: "0017_prebuilds", sql: tenant0017 },
  { name: "0018_build_connections", sql: tenant0018 },
  { name: "0019_prebuild_key_and_providers", sql: tenant0019 },
  { name: "0020_prebuild_uploads", sql: tenant0020 },
  { name: "0021_session_issues", sql: tenant0021 },
  { name: "0022_prebuild_default_branch", sql: tenant0022 },
  { name: "0023_namespace_audience_defined", sql: tenant0023 },
  { name: "0024_session_issue_keys", sql: tenant0024 },
  { name: "0025_derived_git_identity", sql: tenant0025 },
  { name: "0026_prebuild_runs", sql: tenant0026 },
  { name: "0027_secret_set_github_users", sql: tenant0027 },
  { name: "0028_claude_setups", sql: tenant0028 },
  { name: "0029_circleci", sql: tenant0029 },
  { name: "0030_prebuild_pipelines", sql: tenant0030 },
  { name: "0031_prebuild_upload_jobs", sql: tenant0031 },
  { name: "0032_prebuild_pipeline_projects", sql: tenant0032 },
  { name: "0033_circleci_authorizations", sql: tenant0033 },
  { name: "0034_one_running_claude_setup", sql: tenant0034 },
  { name: "0035_circleci_authorization_phases", sql: tenant0035 },
  { name: "0036_github_accounts", sql: tenant0036 },
  { name: "0037_openrouter_authorizations", sql: tenant0037 },
  { name: "0038_github_account_readings", sql: tenant0038 },
  { name: "0039_claude_setup_reports", sql: tenant0039 },
  { name: "0040_openrouter_authorization_exchanges", sql: tenant0040 },
  { name: "0041_prebuild_config_source", sql: tenant0041 },
  { name: "0042_drop_claude_setup_reports", sql: tenant0042 },
  { name: "0043_supervisor_updates", sql: tenant0043 },
  { name: "0044_prebuild_commits", sql: tenant0044 },
  { name: "0045_prebuild_default_commands", sql: tenant0045 },
  { name: "0046_supervisor_update_latest", sql: tenant0046 },
  { name: "0047_drop_prebuild_default_commands", sql: tenant0047 },
  { name: "0048_prebuild_head_sha", sql: tenant0048 },
  { name: "0049_supervisor_update_latest_without_updated_at", sql: tenant0049 },
  { name: "0050_supervisor_update_step_release_and_boxes", sql: tenant0050 },
  { name: "0051_drop_unused_github_tables", sql: tenant0051 },
  { name: "0052_host_usage_channel_protocol", sql: tenant0052 },
  { name: "0053_prebuild_sessions", sql: tenant0053 },
  { name: "0054_claude_setup_harness", sql: tenant0054 },
  { name: "0055_turn_metric_dimensions", sql: tenant0055 },
  { name: "0056_deferred_offers", sql: tenant0056 },
  { name: "0057_persona_box_memory", sql: tenant0057 },
  { name: "0058_turn_results", sql: tenant0058 },
  { name: "0059_turn_images_and_session_layers", sql: tenant0059 },
  { name: "0060_turn_goals", sql: tenant0060 },
  { name: "0061_box_disk", sql: tenant0061 },
  { name: "0062_session_placements", sql: tenant0062 },
  { name: "0063_restore_session_chunks", sql: tenant0063 },
  { name: "0064_connectors", sql: tenant0064 },
  { name: "0065_box_memory_min_512", sql: tenant0065 },
  { name: "0066_host_memory_usage", sql: tenant0066 },
  { name: "0067_box_retention", sql: tenant0067 },
  { name: "0068_turn_release_waits", sql: tenant0068 },
  { name: "0069_events", sql: tenant0069 },
  { name: "0070_snapshot_manifest_chunks", sql: tenant0070 },
  { name: "0071_turn_timing_starts", sql: tenant0071 },
  { name: "0072_turn_session_waits", sql: tenant0072 },
  { name: "0073_session_ownership", sql: tenant0073 },
  { name: "0074_persona_tumpel_mcp", sql: tenant0074 },
  { name: "0075_steers", sql: tenant0075 },
  { name: "0076_session_tags", sql: tenant0076 },
  { name: "0077_session_origins", sql: tenant0077 },
  { name: "0078_subscriptions", sql: tenant0078 },
  { name: "0079_object_cleanups", sql: tenant0079 },
  { name: "0080_triggers", sql: tenant0080 },
  { name: "0081_webhooks", sql: tenant0081 },
  { name: "0082_box_eviction_blocks", sql: tenant0082 },
  { name: "0083_turn_capacity_waits", sql: tenant0083 },
  { name: "0084_push_subscriptions", sql: tenant0084 },
  { name: "0085_push_delivery", sql: tenant0085 },
  { name: "0087_retries", sql: tenant0087 },
  { name: "0088_chunk_lists_in_object_storage", sql: tenant0088 },
  { name: "0088_1_drop_chunk_releases", sql: tenant0088_1 },
  { name: "0088_2_drop_snapshot_packs", sql: tenant0088_2 },
  { name: "0088_3_drop_session_chunks", sql: tenant0088_3 },
  { name: "0088_4_drop_chunks", sql: tenant0088_4 },
  { name: "0088_5_drop_packs", sql: tenant0088_5 },
  { name: "0088_6_drop_snapshot_manifest_chunks", sql: tenant0088_6 },
  { name: "0088_7_drop_snapshot_chunks", sql: tenant0088_7 },
  { name: "0089_drop_alarm_bookkeeping", sql: tenant0089 },
  { name: "0090_drop_bookkeeping", sql: tenant0090 },
  { name: "0091_drop_transcript_tables", sql: tenant0091 },
  { name: "0092_drop_ci_prebuilds", sql: tenant0092 },
  { name: "0093_drop_build_providers", sql: tenant0093 },
  { name: "0094_turns_offered", sql: tenant0094 },
  { name: "0095_turns_in_flight", sql: tenant0095 },
  { name: "0096_host_reports", sql: tenant0096 },
  { name: "0097_reconcile_holdings", sql: tenant0097 },
  { name: "0098_subscription_failures", sql: tenant0098 },
  { name: "0099_sessions_host_state", sql: tenant0099 },
  { name: "0100_start_refusals", sql: tenant0100 },
];
