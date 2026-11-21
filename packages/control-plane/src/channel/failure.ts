import { TenantSkew } from "../tenant-api.ts";

const resendable = (error: unknown): boolean =>
  error instanceof TenantSkew ||
  (typeof error === "object" && error !== null && "retryable" in error && error.retryable === true);

export const refusedOrResent = (messageType: string, error: unknown): { type: "Refused"; reason: string } => {
  if (resendable(error)) throw error;
  return {
    type: "Refused",
    reason: `the control plane failed to handle ${messageType}: ${error instanceof Error ? error.message : String(error)}`,
  };
};
