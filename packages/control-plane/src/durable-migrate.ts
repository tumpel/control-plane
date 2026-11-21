export interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS_TABLE = "__migrations";

const applied = (sql: SqlStorage): Set<string> => {
  const [table] = sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", MIGRATIONS_TABLE)
    .toArray();
  if (table === undefined) return new Set();
  return new Set(
    sql
      .exec<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`)
      .toArray()
      .map((row) => row.name),
  );
};

export const migrateDurableObject = async (
  storage: { sql: SqlStorage; sync(): Promise<void> },
  migrations: readonly Migration[],
): Promise<void> => {
  const { sql } = storage;
  const latest = migrations.at(-1);
  if (latest === undefined) return;
  const done = applied(sql);
  if (done.has(latest.name)) return;
  sql.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    sql.exec(migration.sql);
    sql.exec(`INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`, migration.name, Date.now());
    await storage.sync();
  }
};
