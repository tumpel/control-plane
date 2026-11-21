import { DurableObject } from "cloudflare:workers";
import { backoffMs, errorOf, RETRY_LIMIT } from "./backoff.ts";
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

export type DeadlineChanges = { [N in DeadlineName]?: DeadlineOf<N> | null };

type Deadlines = { [N in DeadlineName]?: DeadlineOf<N> };

interface Timers {
  tenantId: string;
  deadlines: Deadlines;
}

const TIMERS_KEY = "timers";
const RETRIES_KEY = "retries";
const RETRY_AT_KEY = "retryAt";
export const SESSION_TIMER_FIRST_RETRY_MS = 2_000;

export class SessionTimer extends DurableObject<Env> {
  async set(tenantId: string, changes: DeadlineChanges): Promise<void> {
    const timers = (await this.ctx.storage.get<Timers>(TIMERS_KEY)) ?? { tenantId, deadlines: {} };
    Object.assign(timers.deadlines, changes);
    for (const [name, deadline] of Object.entries(timers.deadlines) as [DeadlineName, { at: number } | null][]) {
      if (deadline === null) delete timers.deadlines[name];
    }
    await this.save(timers);
  }

  override async alarm(): Promise<void> {
    const timers = await this.ctx.storage.get<Timers>(TIMERS_KEY);
    if (timers === undefined) return;
    const now = Date.now();
    const due = (Object.entries(timers.deadlines) as [DeadlineName, { at: number }][])
      .map(([name, deadline]) => ({ name, deadline }) as DueDeadline)
      .filter(({ deadline }) => deadline.at <= now);
    for (const { name } of due) delete timers.deadlines[name];
    await this.save(timers);
    const api = tenantApi(this.env.TENANT, timers.tenantId);
    const { tenantId } = timers;
    const reach = async (reached: DueDeadline): Promise<unknown> => {
      if (reached.name === "ClaudeSetup")
        return api.call("claudeSetupDeadlineReached", { tenantId, deadline: reached.deadline });
      if (reached.name === "CircleCIAuthorization")
        return api.call("circleCIAuthorizationDeadlineReached", { tenantId, deadline: reached.deadline });
      if (reached.name === "OpenRouterAuthorization")
        return api.call("openRouterAuthorizationDeadlineReached", { deadline: reached.deadline });
      if (isPrebuildDeadline(reached)) return api.call("prebuildDeadlineReached", { tenantId, due: reached });
      return api.call("deadlineReached", { tenantId, due: reached });
    };
    for (const [at, reached] of due.entries()) {
      const failed = await reach(reached).then(() => null, errorOf);
      if (failed !== null) return this.retry(tenantId, due.slice(at), failed);
      if ((await this.ctx.storage.get<number>(RETRIES_KEY)) !== undefined) {
        await this.ctx.storage.delete([RETRIES_KEY, RETRY_AT_KEY]);
      }
    }
  }

  private async retry(tenantId: string, unreached: DueDeadline[], error: Error): Promise<void> {
    const retries = (await this.ctx.storage.get<number>(RETRIES_KEY)) ?? 0;
    const names = unreached.map(({ name, deadline }) => `${name} ${JSON.stringify(deadline)}`).join(", ");
    if (retries > RETRY_LIMIT) {
      await this.ctx.storage.delete([RETRIES_KEY, RETRY_AT_KEY]);
      console.error(
        `SessionTimerFailed: tenant ${tenantId} dropped the deadlines ${names} after ${RETRY_LIMIT} retries and a final attempt, because the tenant stayed unreachable; their targets keep their state: ${error.message}`,
      );
      return;
    }
    const retry = retries + 1;
    const at = Date.now() + backoffMs(retry, SESSION_TIMER_FIRST_RETRY_MS);
    await this.ctx.storage.put({ [RETRIES_KEY]: retry, [RETRY_AT_KEY]: at });
    await this.restore(unreached);
    const attempt =
      retry > RETRY_LIMIT
        ? `final attempt after ${RETRY_LIMIT} retries, which the tenant answers by ending`
        : `retry ${retry} of ${RETRY_LIMIT} for`;
    console.error(`SessionTimerRetry: tenant ${tenantId} ${attempt} ${names}: ${error.message}`);
  }

  private async restore(unreached: DueDeadline[]): Promise<void> {
    const timers = await this.ctx.storage.get<Timers>(TIMERS_KEY);
    if (timers === undefined) throw new Error("the session timers vanished while their deadlines were being reached");
    for (const { name, deadline } of unreached) timers.deadlines[name] ??= deadline as never;
    await this.save(timers);
  }

  private async save(timers: Timers): Promise<void> {
    await this.ctx.storage.put(TIMERS_KEY, timers);
    const next = Math.min(...Object.values(timers.deadlines).map((deadline) => deadline.at));
    if (!Number.isFinite(next)) return this.ctx.storage.deleteAlarm();
    await this.ctx.storage.setAlarm(Math.max(next, (await this.ctx.storage.get<number>(RETRY_AT_KEY)) ?? next));
  }
}
