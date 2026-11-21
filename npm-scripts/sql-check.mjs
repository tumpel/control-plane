#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { baseAllowlist, baseRef, risen } from "./sql-ceiling.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWLIST = "npm-scripts/sql-allowlist.json";
const RULES = "rules/storage.md";
const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;
const SQL_START =
  /^\s*(?:PRAGMA\s|(?:SELECT|INSERT|UPDATE|DELETE|CREATE|WITH|REPLACE|DROP|ALTER)\s[\s\S]*\b(?:FROM|INTO|SET|TABLE|INDEX|TRIGGER|VALUES|WHERE)\b)/;
const SQL_CALL = /(?:sql\.exec|\.prepare)\s*\(/gi;
const REVIEWED = /--\s*bulk-data-reviewed:\s*\S/;

const update = process.argv.includes("--update");

const listFiles = (patterns) =>
  execFileSync("git", ["ls-files", "--", ...patterns], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

const normalize = (text) => text.replace(/\s+/g, " ").trim();

const regexCanStart = (source, index) => {
  const before = source.slice(0, index).trimEnd();
  if (before === "") return true;
  return REGEX_AFTER.has(before.at(-1)) || REGEX_KEYWORDS.test(before);
};

const scan = (source) => {
  const literals = [];
  const mask = [...source];
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) if (mask[index] !== "\n") mask[index] = " ";
  };

  const skipQuoted = (start) => {
    const quote = source[start];
    let index = start + 1;
    while (index < source.length && source[index] !== quote) index += source[index] === "\\" ? 2 : 1;
    literals.push({ start, text: source.slice(start + 1, index) });
    blank(start + 1, index);
    return index + 1;
  };

  const skipRegex = (start) => {
    let index = start + 1;
    let inClass = false;
    while (index < source.length && source[index] !== "\n") {
      const char = source[index];
      if (char === "\\") index += 1;
      else if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) break;
      index += 1;
    }
    blank(start + 1, index);
    return index + 1;
  };

  const skipTemplate = (start) => {
    let index = start + 1;
    while (index < source.length && source[index] !== "`") {
      if (source[index] === "\\") index += 2;
      else if (source[index] === "$" && source[index + 1] === "{") index = scanCode(index + 2, true);
      else index += 1;
    }
    literals.push({ start, text: source.slice(start + 1, index) });
    blank(start + 1, index);
    return index + 1;
  };

  const scanCode = (start, untilBrace) => {
    let index = start;
    let depth = 0;
    while (index < source.length) {
      const char = source[index];
      const next = source[index + 1];
      if (untilBrace && char === "}" && depth === 0) return index + 1;
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      if (char === "/" && (next === "/" || next === "*")) {
        const end = next === "/" ? source.indexOf("\n", index) : source.indexOf("*/", index + 2) + 2;
        const stop = end <= index ? source.length : end;
        blank(index, stop);
        index = stop;
      } else if (char === '"' || char === "'") index = skipQuoted(index);
      else if (char === "`") index = skipTemplate(index);
      else if (char === "/" && regexCanStart(source, index)) index = skipRegex(index);
      else index += 1;
    }
    return index;
  };

  scanCode(0, false);
  return { literals, mask: mask.join("") };
};

const argumentEnd = (mask, start) => {
  let depth = 0;
  for (let index = start; index < mask.length; index += 1) {
    const char = mask[index];
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) {
      if (depth === 0) return index;
      depth -= 1;
    } else if (char === "," && depth === 0) return index;
  }
  return mask.length;
};

const findSites = (source) => {
  const { literals, mask } = scan(source);
  const lineAt = (position) => source.slice(0, position).split("\n").length;
  const byStart = new Map(literals.map((literal) => [literal.start, literal]));
  const sites = literals
    .filter((literal) => SQL_START.test(literal.text))
    .map((literal) => ({ position: literal.start, fingerprint: normalize(literal.text) }));
  const covered = new Set(sites.map((site) => site.position));
  for (const match of mask.matchAll(SQL_CALL)) {
    const open = match.index + match[0].length;
    const first = open + (mask.slice(open).match(/^\s*/)?.[0].length ?? 0);
    const literal = byStart.get(first);
    if (literal) {
      if (covered.has(first)) continue;
      covered.add(first);
      sites.push({ position: first, fingerprint: normalize(literal.text) });
      continue;
    }
    const expression = normalize(source.slice(first, argumentEnd(mask, first)));
    if (expression === "") continue;
    sites.push({ position: first, fingerprint: `expr: ${expression}` });
  }
  return sites.sort((a, b) => a.position - b.position).map((site) => ({ ...site, line: lineAt(site.position) }));
};

const ddlStatements = (sql) =>
  sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'(?:[^']|'')*'/g, "''")
    .split(";")
    .filter((statement) => /^\s*(?:CREATE\s+(?:TEMP\w*\s+)?TABLE|ALTER\s+TABLE)\b/i.test(statement));

const addsBulkColumn = (sql) => ddlStatements(sql).some((statement) => /\b(?:TEXT|BLOB)\b/i.test(statement));

const migrationDirectories = (files) => {
  const directories = new Map();
  for (const file of files) {
    const slash = file.lastIndexOf("/");
    const directory = file.slice(0, slash);
    const name = file.slice(slash + 1);
    if (!directories.has(directory) || name > directories.get(directory)) directories.set(directory, name);
  }
  return directories;
};

const sources = listFiles(["packages/*/src/**.ts", "packages/*/src/**.tsx", "packages/*/src/**.mjs"]);
const found = Object.fromEntries(
  sources
    .map((file) => [file, findSites(readFileSync(`${ROOT}${file}`, "utf8"))])
    .filter(([, sites]) => sites.length > 0),
);
const migrations = listFiles(["packages/*/migrations/**.sql"]);
const previous = existsSync(`${ROOT}${ALLOWLIST}`) ? JSON.parse(readFileSync(`${ROOT}${ALLOWLIST}`, "utf8")) : {};

const base = baseAllowlist(ROOT, ALLOWLIST, process.env);

if (update) {
  const ceiling = risen(found, base);
  if (ceiling.length > 0) {
    console.error(
      `sql update refused: the allowlist only shrinks.\n  ${ceiling.map(({ file, now, before }) => `${file}  ${before} on origin/${baseRef(process.env)}, ${now} now`).join("\n  ")}`,
    );
    process.exit(1);
  }
  const migrationBaseline =
    previous.migrationBaseline ?? Object.fromEntries([...migrationDirectories(migrations)].sort());
  const allowed = Object.fromEntries(
    Object.entries(found)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, sites]) => [file, sites.map((site) => site.fingerprint).sort()]),
  );
  writeFileSync(`${ROOT}${ALLOWLIST}`, `${JSON.stringify({ migrationBaseline, sites: allowed }, null, 2)}\n`);
  const count = Object.values(allowed).reduce((total, sites) => total + sites.length, 0);
  console.log(`sql: wrote ${count} sites in ${Object.keys(allowed).length} files to ${ALLOWLIST}`);
  process.exit(0);
}

const allowed = previous.sites ?? {};
const baseline = previous.migrationBaseline ?? {};
const unlisted = [];
const stale = [];

for (const file of new Set([...Object.keys(found), ...Object.keys(allowed)])) {
  const remaining = new Map();
  for (const fingerprint of allowed[file] ?? []) remaining.set(fingerprint, (remaining.get(fingerprint) ?? 0) + 1);
  for (const site of found[file] ?? []) {
    const left = remaining.get(site.fingerprint) ?? 0;
    if (left > 0) remaining.set(site.fingerprint, left - 1);
    else unlisted.push(`${file}:${site.line}  ${site.fingerprint.slice(0, 100)}`);
  }
  for (const [fingerprint, left] of remaining) {
    for (let index = 0; index < left; index += 1) stale.push(`${file}  ${fingerprint.slice(0, 100)}`);
  }
}

const raised = risen(allowed, base);

const unreviewed = migrations.filter((file) => {
  const slash = file.lastIndexOf("/");
  const after = baseline[file.slice(0, slash)];
  if (after !== undefined && file.slice(slash + 1) <= after) return false;
  const sql = readFileSync(`${ROOT}${file}`, "utf8");
  return addsBulkColumn(sql) && !REVIEWED.test(sql);
});

if (unlisted.length > 0) {
  console.error(`sql check failed: new hand-written SQL is not on the allowlist.\n  ${unlisted.join("\n  ")}`);
  console.error(`Fix: follow ${RULES}. Write the query with Drizzle; the allowlist takes no new entries.`);
}
if (stale.length > 0) {
  console.error(`sql check failed: allowlisted SQL no longer exists.\n  ${stale.join("\n  ")}`);
  console.error(`Fix: remove it from the allowlist with \`npm run sql:update\`.`);
}
if (raised.length > 0) {
  console.error(
    `sql check failed: the allowlist grew against origin/${baseRef(process.env)}.\n  ${raised.map(({ file, now, before }) => `${file}  ${before} -> ${now}`).join("\n  ")}`,
  );
  console.error(`Fix: write the query with Drizzle (${RULES}). The allowlist only shrinks.`);
}
if (unreviewed.length > 0) {
  console.error(`sql check failed: a new migration adds a TEXT or BLOB column.\n  ${unreviewed.join("\n  ")}`);
  console.error(
    `Fix: follow ${RULES}. Bulk data belongs in R2. If the column holds metadata, add \`-- bulk-data-reviewed: <reason>\` to the migration.`,
  );
}
if (unlisted.length + stale.length + unreviewed.length + raised.length > 0) process.exit(1);
const total = Object.values(found).reduce((sum, sites) => sum + sites.length, 0);
console.log(`sql: ${total} hand-written SQL sites match the allowlist`);
