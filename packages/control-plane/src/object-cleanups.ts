import type { SqlValue } from "./metrics-store.ts";

export interface CleanupSql {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): { toArray(): T[] };
}

export interface CleanupStore {
  delete(keys: string[]): Promise<unknown>;
}

const STORE_DELETE_BATCH = 1000;

export const recordObjectCleanups = (sql: CleanupSql, keys: readonly string[]): void => {
  for (const key of keys) sql.exec("INSERT OR IGNORE INTO object_cleanups (storage_key) VALUES (?)", key);
};

export const drainObjectCleanups = async (sql: CleanupSql, store: CleanupStore, tenantId: string): Promise<void> => {
  for (;;) {
    sql.exec(
      `DELETE FROM object_cleanups WHERE storage_key IN (
        SELECT ?1 || '/persona-files/' || digest FROM persona_files
        UNION SELECT ?1 || '/persona-files/' || digest FROM turn_steer_settings)`,
      tenantId,
    );
    const keys = sql
      .exec<{ storage_key: string }>(
        "SELECT storage_key FROM object_cleanups ORDER BY storage_key LIMIT ?",
        STORE_DELETE_BATCH,
      )
      .toArray()
      .map((row) => row.storage_key);
    if (keys.length === 0) return;
    await store.delete(keys);
    sql.exec("DELETE FROM object_cleanups WHERE storage_key IN (SELECT value FROM json_each(?))", JSON.stringify(keys));
  }
};
