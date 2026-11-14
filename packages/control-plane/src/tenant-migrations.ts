import tenant0001 from "../migrations/tenant/0001_tenant.sql";
import tenant0002 from "../migrations/tenant/0002_config.sql";
import tenant0003 from "../migrations/tenant/0003_unique_persona_name.sql";
import tenant0004 from "../migrations/tenant/0004_sessions.sql";
import tenant0005 from "../migrations/tenant/0005_snapshot_outcomes.sql";
import type { Migration } from "./durable-migrate";

export const TENANT_MIGRATIONS: readonly Migration[] = [
  { name: "0001_tenant", sql: tenant0001 },
  { name: "0002_config", sql: tenant0002 },
  { name: "0003_unique_persona_name", sql: tenant0003 },
  { name: "0004_sessions", sql: tenant0004 },
  { name: "0005_snapshot_outcomes", sql: tenant0005 },
];
