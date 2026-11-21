export const RETRY_LIMIT = 10;

export const forgetDeadlineFailures = (sql: SqlStorage, timer: string, names: string[]): void => {
  sql.exec(
    "DELETE FROM deadline_failures WHERE timer = ? AND name IN (SELECT value FROM json_each(?))",
    timer,
    JSON.stringify(names),
  );
};

export const backoffMs = (retry: number, firstMs: number, random: () => number = Math.random): number => {
  const ceiling = firstMs * 2 ** (retry - 1);
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
};

export const retriesElapsedMs = (firstMs: number): number => (firstMs * (2 ** RETRY_LIMIT - 1)) / 2;

export const retryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

export const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));
