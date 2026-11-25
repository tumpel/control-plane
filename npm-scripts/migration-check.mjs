#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migratedDatabase, rows, tableNames } from "./db-schema.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REVIEWED = /--\s*bulk-data-reviewed:\s*\S/;
const CONTRACT_REVIEWED = /--[^\S\r\n]*contract-reviewed:[^\S\r\n]*\S/;
const CONTRACT_BASELINE = {
  "packages/control-plane/migrations": "0028_hosts_without_reported_health.sql",
  "packages/control-plane/migrations/host": "0005_drop_frame_tables.sql",
  "packages/control-plane/migrations/metrics": "0002_metrics_in_analytics_engine.sql",
  "packages/control-plane/migrations/tenant": "0099_sessions_host_state.sql",
};
const BASELINE = {
  "packages/control-plane/migrations": "0025_tenant_tier.sql",
  "packages/control-plane/migrations/host": "0002_host_without_tenant.sql",
  "packages/control-plane/migrations/metrics": "0001_metrics.sql",
  "packages/control-plane/migrations/tenant": "0088_chunk_lists_in_object_storage.sql",
};

const schema = (db) =>
  new Map(
    tableNames(db).map((table) => [
      table,
      new Map(rows(db, `PRAGMA table_xinfo(${JSON.stringify(table)})`).map((column) => [column.name, column])),
    ]),
  );

export const contractChanges = (before, migration) => {
  if (CONTRACT_REVIEWED.test(migration)) return [];
  const db = migratedDatabase(before);
  const old = schema(db);
  db.exec(migration);
  const after = schema(db);
  const changes = [];
  for (const [table, columns] of old) {
    const now = after.get(table);
    if (now === undefined) {
      changes.push(`drops table ${table}`);
      continue;
    }
    for (const name of columns.keys()) if (!now.has(name)) changes.push(`drops column ${table}.${name}`);
    for (const [name, column] of now) {
      if (!columns.has(name) && column.notnull === 1 && column.dflt_value === null) {
        changes.push(`adds ${table}.${name} NOT NULL without a default`);
      }
    }
  }
  return changes;
};

const main = () => {
  const migrations = execFileSync("git", ["ls-files", "--", "packages/*/migrations/**.sql"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  const read = (file) => readFileSync(`${ROOT}${file}`, "utf8");
  const directory = (file) => file.slice(0, file.lastIndexOf("/"));
  const contracts = migrations.flatMap((file) => {
    const after = CONTRACT_BASELINE[directory(file)];
    if (after === undefined || file.slice(file.lastIndexOf("/") + 1) <= after) return [];
    const before = migrations.filter((other) => directory(other) === directory(file) && other < file).map(read);
    return contractChanges(before, read(file)).map((change) => `${file}: ${change}`);
  });
  if (contracts.length > 0) {
    console.error(`migration check failed: a new migration breaks rollback.\n  ${contracts.join("\n  ")}`);
    console.error(
      "Fix: keep the previous release working, or add `-- contract-reviewed: <reason>` after it stops using the old schema.",
    );
    process.exit(1);
  }

  const unreviewed = migrations.filter((file) => {
    const slash = file.lastIndexOf("/");
    const after = BASELINE[file.slice(0, slash)];
    if (after !== undefined && file.slice(slash + 1) <= after) return false;
    const sql = readFileSync(`${ROOT}${file}`, "utf8");
    if (REVIEWED.test(sql)) return false;
    return sql
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/'(?:[^']|'')*'/g, "''")
      .split(";")
      .filter((statement) => /^\s*(?:CREATE\s+(?:TEMP\w*\s+)?TABLE|ALTER\s+TABLE)\b/i.test(statement))
      .some((statement) => /\b(?:TEXT|BLOB)\b/i.test(statement));
  });

  if (unreviewed.length > 0) {
    console.error(`migration check failed: a new migration adds a TEXT or BLOB column.\n  ${unreviewed.join("\n  ")}`);
    console.error(
      "Fix: follow rules/storage.md. Bulk data belongs in R2. If the column holds metadata, add `-- bulk-data-reviewed: <reason>` to the migration.",
    );
    process.exit(1);
  }
  console.log(`migrations: ${migrations.length} checked, no unreviewed contract or TEXT or BLOB column`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
