import type { Env } from "./index";
import { tenantApi } from "./tenant-api.ts";

export type DeadlineName =
  | "FirstLine"
  | "Total"
  | "Snapshot"
  | "SnapshotAnswer"
  | "Teardown"
  | "TeardownAnswer"
  | "HostOffline"
  | PrebuildDeadlineName
  | "ClaudeSetup"
  | "CircleCIAuthorization"
  | "OpenRouterAuthorization";

export type PrebuildDeadlineName = "PrebuildDispatch" | "PrebuildBuild";

export interface Deadline {
  turnId: string;
  at: number;
}

export interface ClaudeSetupDeadline {
  claudeSetupId: string;
  at: number;
}

export interface CircleCIAuthorizationDeadline {
  circleCIAuthorizationId: string;
  at: number;
}

export interface OpenRouterAuthorizationDeadline {
  openRouterAuthorizationId: string;
  at: number;
}

export interface PrebuildDeadline {
  prebuildId: string;
  at: number;
}

type DeadlineOf<N extends DeadlineName> = N extends PrebuildDeadlineName
  ? PrebuildDeadline
  : N extends "ClaudeSetup"
    ? ClaudeSetupDeadline
    : N extends "CircleCIAuthorization"
      ? CircleCIAuthorizationDeadline
      : N extends "OpenRouterAuthorization"
        ? OpenRouterAuthorizationDeadline
        : Deadline;

export type DueDeadline = { [N in DeadlineName]: { name: N; deadline: DeadlineOf<N> } }[DeadlineName];

export type SessionDueDeadline = Exclude<
  DueDeadline,
  { name: PrebuildDeadlineName | "ClaudeSetup" | "CircleCIAuthorization" | "OpenRouterAuthorization" }
>;

export type PrebuildDueDeadline = Extract<DueDeadline, { name: PrebuildDeadlineName }>;

const isPrebuildDeadline = (due: DueDeadline): due is PrebuildDueDeadline =>
  due.name === "PrebuildDispatch" || due.name === "PrebuildBuild";

export type DeadlineChanges = { [N in DeadlineName]?: DeadlineOf<N> };

export interface DeadlineMessage {
  tenantId: string;
  due: DueDeadline;
}

export const MAX_DELAY_SECONDS = 12 * 60 * 60;

const dueOf = (changes: DeadlineChanges): DueDeadline[] =>
  (Object.entries(changes) as [DeadlineName, { at: number }][]).map(
    ([name, deadline]) => ({ name, deadline }) as DueDeadline,
  );

const delaySeconds = (due: DueDeadline, now: number): number => {
  const seconds = Math.max(0, Math.ceil((due.deadline.at - now) / 1000));
  if (seconds <= MAX_DELAY_SECONDS) return seconds;
  throw new Error(
    `the ${due.name} deadline is ${seconds} seconds away, past the ${MAX_DELAY_SECONDS} seconds a queue delays a message; shorten the budget that sets it`,
  );
};

export const armDeadlines = async (env: Env, tenantId: string, changes: DeadlineChanges): Promise<void> => {
  const now = Date.now();
  const messages = dueOf(changes).map((due) => ({
    body: { tenantId, due } satisfies DeadlineMessage,
    delaySeconds: delaySeconds(due, now),
  }));
  if (messages.length > 0) await env.DEADLINES.sendBatch(messages);
};

const reach = (env: Env, { tenantId, due }: DeadlineMessage): Promise<unknown> => {
  const api = tenantApi(env.TENANT, tenantId);
  if (due.name === "ClaudeSetup") return api.call("claudeSetupDeadlineReached", { tenantId, deadline: due.deadline });
  if (due.name === "CircleCIAuthorization")
    return api.call("circleCIAuthorizationDeadlineReached", { tenantId, deadline: due.deadline });
  if (due.name === "OpenRouterAuthorization")
    return api.call("openRouterAuthorizationDeadlineReached", { deadline: due.deadline });
  if (isPrebuildDeadline(due)) return api.call("prebuildDeadlineReached", { tenantId, due, retries: 0 });
  return api.call("deadlineReached", { tenantId, due, retries: 0 });
};

export const reachDeadlines = async (env: Env, batch: MessageBatch<DeadlineMessage>): Promise<void> => {
  for (const message of batch.messages) {
    await reach(env, message.body);
    message.ack();
  }
};
