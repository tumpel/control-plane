import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SESSION_TABLES, TURN_TABLES } from "../src/session-tables.ts";

const MIGRATIONS = new URL("../migrations/tenant/", import.meta.url);
const ARCHIVE_CLEARS = ["snapshots", "snapshot_requests", "snapshot_failures"];

test("a session delete reaches every table that holds a session or a turn", () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const name of readdirSync(MIGRATIONS).sort()) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sessions', '_cf_KV')")
    .all()
    .map((row) => String(row.name));
  const reached = new Set<string>([...SESSION_TABLES, ...TURN_TABLES, ...ARCHIVE_CLEARS]);
  const missed = tables.filter((table) => {
    const columns = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => String(column.name));
    const keyed = columns.filter((column) => column === "session_id" || column === "turn_id");
    if (keyed.length === 0 || reached.has(table)) return false;
    const cascades = db
      .prepare(`PRAGMA foreign_key_list(${table})`)
      .all()
      .filter((key) => key.on_delete === "CASCADE")
      .map((key) => String(key.from));
    return !keyed.every((column) => cascades.includes(column));
  });
  assert.deepEqual(missed, []);
});
