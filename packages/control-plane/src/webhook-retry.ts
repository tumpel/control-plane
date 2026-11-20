const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60 * 1000;

export const webhookRetryDelay = (failures: number): number =>
  Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);
