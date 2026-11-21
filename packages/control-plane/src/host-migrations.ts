import host0001 from "../migrations/host/0001_host.sql";
import host0002 from "../migrations/host/0002_host_without_tenant.sql";

export const HOST_MIGRATIONS = [
  { name: "0001_host", sql: host0001 },
  { name: "0002_host_without_tenant", sql: host0002 },
];
