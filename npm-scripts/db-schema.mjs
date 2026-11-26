#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FORMAT_AS = "packages/control-plane/src/db/schema.ts";

export const STORES = [
  { migrations: "packages/control-plane/migrations", schema: "packages/control-plane/src/db/central-schema.ts" },
  { migrations: "packages/control-plane/migrations/host", schema: "packages/control-plane/src/db/host-schema.ts" },
  {
    migrations: "packages/control-plane/migrations/tenant",
    schema: "packages/control-plane/src/db/tenant-schema.ts",
  },
  {
    migrations: "packages/control-plane/migrations/metrics",
    schema: "packages/control-plane/src/db/metrics-schema.ts",
  },
];

const BUILDERS = { INTEGER: "integer", INT: "integer", TEXT: "text", REAL: "real", BLOB: "blob" };

const camel = (name) => name.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());

const rows = (db, query) => db.prepare(query).all();

const migratedDatabase = (directory) => {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) db.exec(readFileSync(join(directory, file), "utf8"));
  return db;
};

const tableNames = (db) =>
  rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(
    (row) => row.name,
  );

const indexColumns = (db, index) =>
  rows(db, `PRAGMA index_info(${JSON.stringify(index)})`)
    .sort((a, b) => a.seqno - b.seqno)
    .map((column) => {
      if (column.name === null) throw new Error(`index ${index} is on an expression; db-schema.mjs cannot derive it`);
      return column.name;
    });

const describe = (db, table) => {
  const columns = rows(db, `PRAGMA table_xinfo(${JSON.stringify(table)})`).filter((column) => column.hidden === 0);
  const keys = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
  const references = rows(db, `PRAGMA foreign_key_list(${JSON.stringify(table)})`);
  const groups = Map.groupBy(references, (reference) => reference.id);
  const referenced = new Map();
  const composite = [];
  for (const group of groups.values()) {
    const ordered = group.sort((a, b) => a.seq - b.seq);
    if (ordered.length === 1) referenced.set(ordered[0].from, ordered[0]);
    else composite.push(ordered);
  }
  const indexes = rows(db, `PRAGMA index_list(${JSON.stringify(table)})`).filter((index) => index.origin !== "pk");
  return { table, columns, keys, referenced, composite, indexes };
};

const columnSource = ({ keys, referenced }, column) => {
  const builder = BUILDERS[column.type.toUpperCase()];
  if (builder === undefined) throw new Error(`column ${column.name} has type ${column.type}, which has no builder`);
  let source = `${builder}("${column.name}")`;
  if (column.notnull === 1) source += ".notNull()";
  if (keys.length === 1 && keys[0].name === column.name) source += ".primaryKey()";
  if (column.dflt_value !== null) source += `.default(sql\`${column.dflt_value}\`)`;
  const reference = referenced.get(column.name);
  if (reference !== undefined) {
    const target = rowsTarget(reference);
    source += `.references((): AnySQLiteColumn => ${target}.${camel(reference.to)}${referenceOptions(reference)})`;
  }
  return { builder, source: `${camel(column.name)}: ${source}` };
};

const rowsTarget = (reference) => camel(reference.table);

const ACTIONS = { CASCADE: "cascade", "SET NULL": "set null", RESTRICT: "restrict", "SET DEFAULT": "set default" };

const referenceOptions = (reference) => {
  const action = ACTIONS[reference.on_delete];
  return action === undefined ? "" : `, { onDelete: "${action}" }`;
};

const cascade = (reference) => {
  const action = ACTIONS[reference.on_delete];
  return action === undefined ? "" : `.onDelete("${action}")`;
};

const partialWhere = (db, index) => {
  const { sql: definition } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(index);
  const where = definition.match(/\)\s+WHERE\s+([\s\S]+)$/i);
  if (where === null) throw new Error(`index ${index} is partial but its WHERE clause could not be read`);
  return `.where(sql\`${where[1].trim()}\`)`;
};

const tableSource = (db, description, used) => {
  const { table, columns, keys, composite, indexes } = description;
  const fields = columns.map((column) => {
    const { builder, source } = columnSource(description, column);
    used.add(builder);
    if (source.includes("AnySQLiteColumn")) used.add("type AnySQLiteColumn");
    return `  ${source},`;
  });
  const extras = [];
  if (keys.length > 1) {
    used.add("primaryKey");
    extras.push(`primaryKey({ columns: [${keys.map((key) => `table.${camel(key.name)}`).join(", ")}] })`);
  }
  for (const group of composite) {
    used.add("foreignKey");
    const own = group.map((reference) => `table.${camel(reference.from)}`).join(", ");
    const foreign = group.map((reference) => `${camel(reference.table)}.${camel(reference.to)}`).join(", ");
    extras.push(`foreignKey({ columns: [${own}], foreignColumns: [${foreign}] })${cascade(group[0])}`);
  }
  for (const index of indexes) {
    const members = indexColumns(db, index.name)
      .map((name) => `table.${camel(name)}`)
      .join(", ");
    if (index.origin === "u") {
      used.add("unique");
      extras.push(`unique().on(${members})`);
    } else {
      const builder = index.unique === 1 ? "uniqueIndex" : "index";
      used.add(builder);
      const where = index.partial === 1 ? partialWhere(db, index.name) : "";
      extras.push(`${builder}("${index.name}").on(${members})${where}`);
    }
  }
  const tail = extras.length === 0 ? "" : `, (table) => [${extras.join(", ")}]`;
  return `export const ${camel(table)} = sqliteTable("${table}", {\n${fields.join("\n")}\n}${tail});`;
};

export const schemaSource = (directory) => {
  const db = migratedDatabase(directory);
  const used = new Set(["sqliteTable"]);
  const descriptions = tableNames(db).map((table) => describe(db, table));
  const body = descriptions.map((description) => tableSource(db, description, used)).join("\n\n");
  const needsSql = body.includes("sql`");
  const imports = [...used].sort().join(", ");
  const lines = [`import { ${imports} } from "drizzle-orm/sqlite-core";`];
  if (needsSql) lines.unshift(`import { sql } from "drizzle-orm";`);
  return `${lines.join("\n")}\n\n${body}\n`;
};

const formatted = (source) =>
  execFileSync("npx", ["--no-install", "biome", "check", "--write", `--stdin-file-path=${FORMAT_AS}`], {
    cwd: REPO,
    encoding: "utf8",
    input: source,
  });

export const expectedSchemas = (root) =>
  STORES.map((store) => ({
    path: store.schema,
    source: formatted(schemaSource(join(root, store.migrations))),
  }));

const main = () => {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf("--root");
  const root = rootFlag === -1 ? REPO : args[rootFlag + 1];
  const check = args.includes("--check");
  const stale = [];
  for (const { path, source } of expectedSchemas(root)) {
    const target = join(root, path);
    if (check) {
      if (!existsSync(target) || readFileSync(target, "utf8") !== source) stale.push(path);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  if (stale.length > 0) {
    console.error(`db schema check failed: ${stale.join(", ")} no longer match the migrations.`);
    console.error("Fix: run `npm run db:schema` and commit the result.");
    process.exit(1);
  }
  console.log(check ? "db schema: generated files match the migrations" : "db schema: wrote generated files");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
