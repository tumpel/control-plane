import host0001 from "../migrations/host/0001_host.sql";
import host0002 from "../migrations/host/0002_host_without_tenant.sql";
import host0003 from "../migrations/host/0003_frame_trips.sql";
import host0004 from "../migrations/host/0004_refused_frames.sql";
import host0005 from "../migrations/host/0005_drop_refused_frames.sql";

export const HOST_MIGRATIONS = [
  { name: "0001_host", sql: host0001 },
  { name: "0002_host_without_tenant", sql: host0002 },
  { name: "0003_frame_trips", sql: host0003 },
  { name: "0004_refused_frames", sql: host0004 },
  { name: "0005_drop_refused_frames", sql: host0005 },
];
