export const retryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

export const errorOf = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));
