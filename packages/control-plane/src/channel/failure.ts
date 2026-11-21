import { TenantSkew } from "../tenant-api.ts";

const LINES_LOST = "TranscriptLinesLost";
const LINES_NOT_STORED = "TranscriptLinesNotStored";

export const linesLost = (detail: string): Error => new Error(`${LINES_LOST}: ${detail}`);

export const linesNotStored = (detail: string): Error => new Error(`${LINES_NOT_STORED}: ${detail}`);

const carries = (error: unknown, marker: string): boolean => error instanceof Error && error.message.includes(marker);

export const lost = (error: unknown): boolean => carries(error, LINES_LOST);

export const resendable = (error: unknown): boolean =>
  error instanceof TenantSkew ||
  carries(error, LINES_LOST) ||
  carries(error, LINES_NOT_STORED) ||
  (typeof error === "object" && error !== null && "retryable" in error && error.retryable === true);

export const refusedOrResent = (messageType: string, error: unknown): { type: "Refused"; reason: string } => {
  if (resendable(error)) throw error;
  return {
    type: "Refused",
    reason: `the control plane failed to handle ${messageType}: ${error instanceof Error ? error.message : String(error)}`,
  };
};
