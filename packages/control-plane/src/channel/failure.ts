import { TenantSkew } from "../tenant-api.ts";

export const resendable = (error: unknown): boolean =>
  error instanceof TenantSkew ||
  (typeof error === "object" && error !== null && "retryable" in error && error.retryable === true);

export const refusal = (messageType: string, error: unknown): { type: "Refused"; reason: string } => ({
  type: "Refused",
  reason: `the control plane failed to handle ${messageType}: ${error instanceof Error ? error.message : String(error)}`,
});
