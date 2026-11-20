import type { SqlValue } from "./metrics-store.ts";
import { personaFileKey } from "./persona-files.ts";

export interface CleanupSql {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): { toArray(): T[] };
}

export interface CleanupStore {
  delete(keys: string[]): Promise<unknown>;
}

const STORE_DELETE_BATCH = 1000;

export const recordPersonaFileCleanups = (sql: CleanupSql, digests: readonly string[]): void => {
  for (const digest of digests) sql.exec("INSERT OR IGNORE INTO persona_file_cleanups (digest) VALUES (?)", digest);
};

export const drainPersonaFileCleanups = async (
  sql: CleanupSql,
  store: CleanupStore,
  tenantId: string,
): Promise<void> => {
  sql.exec(
    `DELETE FROM persona_file_cleanups
    WHERE digest IN (SELECT digest FROM persona_files) OR digest IN (SELECT digest FROM turn_steer_settings)`,
  );
  const digests = sql
    .exec<{ digest: string }>("SELECT digest FROM persona_file_cleanups LIMIT ?", STORE_DELETE_BATCH)
    .toArray()
    .map((row) => row.digest);
  if (digests.length === 0) return;
  await store.delete(digests.map((digest) => personaFileKey(tenantId, digest)));
  sql.exec(
    "DELETE FROM persona_file_cleanups WHERE digest IN (SELECT value FROM json_each(?))",
    JSON.stringify(digests),
  );
};
