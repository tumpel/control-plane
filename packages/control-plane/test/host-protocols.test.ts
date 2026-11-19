import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { onlineChannelProtocols, protocolsOf, recordProtocols } from "../src/host-protocols.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

const centralDatabase = (): { sqlite: DatabaseSync; db: D1Database } => {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  }
  const statement = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...bound: SQLInputValue[]) => statement(sql, bound),
    run: async () => sqlite.prepare(sql).run(...values),
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
  });
  const db: unknown = { prepare: (sql: string) => statement(sql) };
  return { sqlite, db: db as D1Database };
};

const enrol = (sqlite: DatabaseSync, hostId: string, state: string): void => {
  sqlite.exec("INSERT OR IGNORE INTO tenants (tenant_id, name, created_at, updated_at) VALUES ('tnt', 'acme', 1, 1)");
  sqlite
    .prepare(
      `INSERT INTO hosts (host_id, tenant_id, name, state, architecture, cpu_count, memory_bytes, public_key, supervisor_version, created_at, updated_at)
      VALUES (?, 'tnt', ?, ?, 'Amd64', 4, 1024, 'key', '0.1.0', 1, 1)`,
    )
    .run(hostId, hostId, state);
};

const hello = async (
  db: D1Database,
  hostId: string,
  channel: [number, number],
  guest: [number, number] | null,
  now: number,
): Promise<void> => {
  for (const statement of recordProtocols(
    db,
    hostId,
    {
      channelProtocol: { state: "Reported", channelProtocolOldest: channel[0], channelProtocolVersion: channel[1] },
      guestProtocol:
        guest === null
          ? { state: "NotReported" }
          : { state: "Reported", guestProtocolOldest: guest[0], guestProtocolVersion: guest[1] },
    },
    now,
  )) {
    await statement.run();
  }
};

test("each Hello records the host's latest channel and guest protocol ranges, and an unannounced guest range reads not reported", async () => {
  const { sqlite, db } = centralDatabase();
  enrol(sqlite, "hst_a", "Online");
  enrol(sqlite, "hst_b", "Enrolled");

  await hello(db, "hst_a", [26, 28], [9, 14], 1000);
  assert.deepEqual(await protocolsOf(db, ["hst_a", "hst_b"]), {
    hst_a: {
      channelProtocol: { state: "Reported", channelProtocolOldest: 26, channelProtocolVersion: 28 },
      guestProtocol: { state: "Reported", guestProtocolOldest: 9, guestProtocolVersion: 14 },
    },
    hst_b: { channelProtocol: { state: "NotReported" }, guestProtocol: { state: "NotReported" } },
  });

  await hello(db, "hst_a", [27, 29], null, 2000);
  assert.deepEqual(await protocolsOf(db, ["hst_a"]), {
    hst_a: {
      channelProtocol: { state: "Reported", channelProtocolOldest: 27, channelProtocolVersion: 29 },
      guestProtocol: { state: "NotReported" },
    },
  });
});

test("a range whose oldest version lies above its newest never reaches the table", async () => {
  const { sqlite, db } = centralDatabase();
  enrol(sqlite, "hst_a", "Online");
  await assert.rejects(hello(db, "hst_a", [29, 28], null, 1000), /CHECK constraint failed/);
});

test("the rollout counts only Online hosts per newest channel protocol version, oldest first", async () => {
  const { sqlite, db } = centralDatabase();
  for (const [hostId, state, version] of [
    ["hst_a", "Online", 28],
    ["hst_b", "Online", 26],
    ["hst_c", "Online", 28],
    ["hst_d", "Offline", 20],
    ["hst_e", "Revoked", 19],
  ] as const) {
    enrol(sqlite, hostId, state);
    await hello(db, hostId, [version, version], null, 1000);
  }
  assert.deepEqual(await onlineChannelProtocols(db), [
    { channelProtocolVersion: 26, hostCount: 1 },
    { channelProtocolVersion: 28, hostCount: 2 },
  ]);
});
