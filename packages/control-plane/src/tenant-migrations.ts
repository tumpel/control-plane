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
];
