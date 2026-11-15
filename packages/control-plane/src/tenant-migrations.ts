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
];
