import {
  type ClaudeSetupFailureReasonSchema,
  ClaudeSetupMemberSchema,
  ClaudeSetupSchema,
  ClaudeSetupStateSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import type { BootImage, ClaudeSetupBoxOffer } from "./channel/protocol.ts";
import type { Settings } from "./settings.ts";

export type ClaudeSetup = z.infer<typeof ClaudeSetupSchema>;
export type ClaudeSetupFailureReason = z.infer<typeof ClaudeSetupFailureReasonSchema>;

export const CLAUDE_SETUP_MEMBER = ClaudeSetupMemberSchema.enum.CLAUDE_CODE_OAUTH_TOKEN;

export const TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

export type ClaudeSetupState = ClaudeSetup["status"]["state"];

export type LivePhase = "Starting" | "AwaitingCode" | "Minting";

export type ClaudeSetupBudgets = Pick<
  Settings,
  | "claudeSetupUrlBudgetSeconds"
  | "claudeSetupCodeBudgetSeconds"
  | "claudeSetupMintBudgetSeconds"
  | "claudeSetupMintGraceSeconds"
>;

export type ClaudeSetupEvent =
  | { kind: "Url"; signInUrl: string }
  | { kind: "Code" }
  | { kind: "Stored" }
  | { kind: "BoxFailed"; reason: ClaudeSetupFailureReason; detail: string }
  | { kind: "Deadline" };

export type ClaudeSetupStep =
  | { kind: "Advance"; state: "AwaitingCode" | "Minting"; dueInSeconds: number }
  | { kind: "Complete" }
  | { kind: "Fail"; reason: ClaudeSetupFailureReason; detail: string }
  | { kind: "Ignore" }
  | { kind: "Refuse"; detail: string };

const isLive = (state: ClaudeSetupState): state is LivePhase =>
  state === "Starting" || state === "AwaitingCode" || state === "Minting";

const START_AGAIN = "start the Claude setup again";

const mintTimedOut = (claudeSetupId: string, budgets: ClaudeSetupBudgets): string =>
  `the box of Claude setup ${claudeSetupId} reported nothing within claudeSetupMintBudgetSeconds ${budgets.claudeSetupMintBudgetSeconds} plus claudeSetupMintGraceSeconds ${budgets.claudeSetupMintGraceSeconds} of the code; check that the host is online, then ${START_AGAIN}`;

const timedOut = (claudeSetupId: string, phase: LivePhase, budgets: ClaudeSetupBudgets): ClaudeSetupStep => {
  if (phase === "Starting") {
    return {
      kind: "Fail",
      reason: "SetupUrlMissing",
      detail: `the box of Claude setup ${claudeSetupId} printed no sign-in URL within claudeSetupUrlBudgetSeconds ${budgets.claudeSetupUrlBudgetSeconds}; check that the host fetched the pinned Claude Code image and can reach claude.ai, then ${START_AGAIN}`,
    };
  }
  if (phase === "AwaitingCode") {
    return {
      kind: "Fail",
      reason: "SetupTimedOut",
      detail: `no code reached Claude setup ${claudeSetupId} within claudeSetupCodeBudgetSeconds ${budgets.claudeSetupCodeBudgetSeconds} of its sign-in URL; ${START_AGAIN}, sign in at the new URL and submit the code the page shows`,
    };
  }
  return { kind: "Fail", reason: "SetupTimedOut", detail: mintTimedOut(claudeSetupId, budgets) };
};

export const advance = (
  claudeSetupId: string,
  state: ClaudeSetupState,
  event: ClaudeSetupEvent,
  budgets: ClaudeSetupBudgets,
): ClaudeSetupStep => {
  if (!isLive(state)) {
    return event.kind === "Code"
      ? { kind: "Refuse", detail: `Claude setup ${claudeSetupId} is ${state} and takes no code` }
      : { kind: "Ignore" };
  }
  if (event.kind === "Deadline") return timedOut(claudeSetupId, state, budgets);
  if (event.kind === "BoxFailed") return { kind: "Fail", reason: event.reason, detail: event.detail };
  if (event.kind === "Url") {
    return state === "Starting"
      ? { kind: "Advance", state: "AwaitingCode", dueInSeconds: budgets.claudeSetupCodeBudgetSeconds }
      : { kind: "Ignore" };
  }
  if (event.kind === "Code") {
    return state === "AwaitingCode"
      ? {
          kind: "Advance",
          state: "Minting",
          dueInSeconds: budgets.claudeSetupMintBudgetSeconds + budgets.claudeSetupMintGraceSeconds,
        }
      : {
          kind: "Refuse",
          detail:
            state === "Starting"
              ? `Claude setup ${claudeSetupId} has no sign-in URL yet; read it until it is AwaitingCode, sign in at its signInUrl, then submit the code`
              : `Claude setup ${claudeSetupId} already took a code`,
        };
  }
  return state === "Minting"
    ? { kind: "Complete" }
    : { kind: "Refuse", detail: `Claude setup ${claudeSetupId} is ${state} and takes no token before its code` };
};

export type ClaudeSetupRow = {
  claude_setup_id: string;
  principal_id: string;
  secret_set_id: string;
  host_id: string;
  box_id: string;
  harness_version: string;
  endpoint: string;
  state: string;
  phase_due_at: number;
  sign_in_url: string | null;
  reason: string | null;
  detail: string | null;
  expires_at: string | null;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
};

export const stateOf = (row: ClaudeSetupRow): ClaudeSetupState => ClaudeSetupStateSchema.parse(row.state);

const iso = (at: number): string => new Date(at).toISOString();

const endedAt = (row: ClaudeSetupRow): string => {
  if (row.ended_at === null) {
    throw new Error(
      `Claude setup ${row.claude_setup_id} is ${row.state} and has no ended_at; the row was written without one`,
    );
  }
  return iso(row.ended_at);
};

export const boxEndsAt = (createdAt: number, budgets: ClaudeSetupBudgets): number =>
  createdAt +
  (budgets.claudeSetupUrlBudgetSeconds +
    budgets.claudeSetupCodeBudgetSeconds +
    budgets.claudeSetupMintBudgetSeconds +
    budgets.claudeSetupMintGraceSeconds) *
    1000;

const statusOf = (row: ClaudeSetupRow): Record<string, unknown> => {
  if (row.state === "Starting") return { state: row.state, urlDueAt: iso(row.phase_due_at) };
  if (row.state === "Minting") return { state: row.state, tokenDueAt: iso(row.phase_due_at) };
  if (row.state === "AwaitingCode") {
    return { state: row.state, signInUrl: row.sign_in_url, codeDueAt: iso(row.phase_due_at) };
  }
  if (row.state === "Completed") {
    return {
      state: row.state,
      memberName: CLAUDE_SETUP_MEMBER,
      expiresAt: row.expires_at,
      completedAt: endedAt(row),
    };
  }
  if (row.state === "Failed") {
    return { state: row.state, reason: row.reason, detail: row.detail, failedAt: endedAt(row) };
  }
  throw new Error(`Claude setup ${row.claude_setup_id} is in state ${row.state}, which ClaudeSetupState does not name`);
};

export const overdue = (row: ClaudeSetupRow, now: number): boolean => isLive(stateOf(row)) && now >= row.phase_due_at;

export const toClaudeSetup = (tenantId: string, row: ClaudeSetupRow): ClaudeSetup =>
  ClaudeSetupSchema.parse({
    claudeSetupId: row.claude_setup_id,
    tenantId,
    principalId: row.principal_id,
    secretSetId: row.secret_set_id,
    hostId: row.host_id,
    boxId: row.box_id,
    harnessVersion: row.harness_version,
    status: statusOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export const tokenUrl = (endpoint: string, claudeSetupId: string): string =>
  `${endpoint}/v1/claude-setups/${encodeURIComponent(claudeSetupId)}/token`;

export const setupOffer = (
  tenantId: string,
  row: ClaudeSetupRow,
  image: BootImage,
  tokenCredential: string,
  budgets: ClaudeSetupBudgets,
): ClaudeSetupBoxOffer => ({
  type: "ClaudeSetupBoxOffer",
  claudeSetupId: row.claude_setup_id,
  tenantId,
  boxId: row.box_id,
  harnessVersion: row.harness_version,
  image,
  tokenUrl: tokenUrl(row.endpoint, row.claude_setup_id),
  tokenCredential,
  expiresAt: iso(boxEndsAt(row.created_at, budgets)),
});
