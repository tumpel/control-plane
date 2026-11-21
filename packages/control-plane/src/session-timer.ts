import { DurableObject } from "cloudflare:workers";
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
      if (isPrebuildDeadline(reached))
        return api.call("prebuildDeadlineReached", { tenantId, due: reached, retries: 0 });
      return api.call("deadlineReached", { tenantId, due: reached, retries: 0 });
    };
    for (const [at, reached] of due.entries()) {
      await reach(reached).catch(async (error: unknown) => {
        await this.restore(due.slice(at));
        throw error;
      });
    }
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
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
}
