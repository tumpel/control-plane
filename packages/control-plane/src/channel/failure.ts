import { TenantSkew } from "../tenant-api.ts";

const LINES_LOST = "TranscriptLinesLost";

export const linesLost = (detail: string): Error => new Error(`${LINES_LOST}: ${detail}`);

const carries = (error: unknown, marker: string): boolean => error instanceof Error && error.message.includes(marker);

export const lost = (error: unknown): boolean => carries(error, LINES_LOST);

export const resendable = (error: unknown): boolean =>
  error instanceof TenantSkew ||
  carries(error, LINES_LOST) ||
  (typeof error === "object" && error !== null && "retryable" in error && error.retryable === true);

export const refusedOrResent = (messageType: string, error: unknown): { type: "Refused"; reason: string } => {
  if (resendable(error)) throw error;
  return {
    type: "Refused",
    reason: `the control plane failed to handle ${messageType}: ${error instanceof Error ? error.message : String(error)}`,
  };
};
