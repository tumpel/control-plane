#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REVIEWED = /--\s*bulk-data-reviewed:\s*\S/;
const BASELINE = {
  "packages/control-plane/migrations": "0025_tenant_tier.sql",
  "packages/control-plane/migrations/host": "0002_host_without_tenant.sql",
  "packages/control-plane/migrations/metrics": "0001_metrics.sql",
  "packages/control-plane/migrations/tenant": "0088_chunk_lists_in_object_storage.sql",
};

const migrations = execFileSync("git", ["ls-files", "--", "packages/*/migrations/**.sql"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

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
console.log(`migrations: ${migrations.length} checked, no unreviewed TEXT or BLOB column`);
