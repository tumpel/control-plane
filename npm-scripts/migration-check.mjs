#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REVIEWED = /--\s*bulk-data-reviewed:\s*\S/;
const D1 = "packages/control-plane/migrations";
const CONTRACT_BASELINE = "0028_hosts_without_reported_health.sql";
const BASELINE = {
  [D1]: "0025_tenant_tier.sql",
  "packages/control-plane/migrations/host": "0002_host_without_tenant.sql",
  "packages/control-plane/migrations/metrics": "0001_metrics.sql",
  "packages/control-plane/migrations/tenant": "0088_chunk_lists_in_object_storage.sql",
};

function hasUnreviewedContract(sql) {
  let reviewed = false;
  const statements = sql
    .replace(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g, (token) => {
      if (/^--[^\S\r\n]*contract-reviewed:[^\S\r\n]*\S/.test(token)) reviewed = true;
      return token.startsWith("--") || token.startsWith("/*") ? " " : '""';
    })
    .split(";");
  return (
    !reviewed &&
    statements.some((statement) => {
      if (/^\s*DROP\s+TABLE\b/i.test(statement)) return true;
      const alter = /^\s*ALTER\s+TABLE\s+[^\s.]+(?:\s*\.\s*[^\s.]+)?\s+([\s\S]*)/i.exec(statement)?.[1];
      if (alter === undefined) return false;
      if (/^(?:DROP|RENAME)\b/i.test(alter)) return true;
      if (!/^ADD\b/i.test(alter)) return false;
      let depth = 0;
      const definition = alter.replace(/\(|\)|[^()]+/g, (token) => {
        if (token === "(") depth += 1;
        if (token === ")") depth -= 1;
        return depth === 0 ? token : " ";
      });
      return /\bNOT\s+NULL\b/i.test(definition) && !/(?<!\bSET\s+)\bDEFAULT\b/i.test(definition);
    })
  );
}

const migrations = execFileSync("git", ["ls-files", "--", "packages/*/migrations/**.sql"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

const contracts = migrations.filter((file) => {
  const slash = file.lastIndexOf("/");
  return (
    file.slice(0, slash) === D1 &&
    file.slice(slash + 1) > CONTRACT_BASELINE &&
    hasUnreviewedContract(readFileSync(`${ROOT}${file}`, "utf8"))
  );
});
if (contracts.length > 0) {
  console.error(`migration check failed: a new D1 migration breaks rollback.\n  ${contracts.join("\n  ")}`);
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
