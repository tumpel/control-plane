import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

export type DeadlineName =
  | "Claim"
  | "ImageFetch"
  | "FirstLine"
  | "Total"
  | "Snapshot"
  | "SnapshotAnswer"
  | "Teardown"
  | "TeardownAnswer"
  | "HostOffline"
  | PrebuildDeadlineName;

export type PrebuildDeadlineName = "PrebuildDispatch" | "PrebuildBuild";

export interface Deadline {
  turnId: string;
  at: number;
}

export interface ImageFetchDeadline extends Deadline {
  imageDigest: string;
}

export interface PrebuildDeadline {
  prebuildId: string;
  at: number;
}

type DeadlineOf<N extends DeadlineName> = N extends "ImageFetch"
  ? ImageFetchDeadline
  : N extends PrebuildDeadlineName
    ? PrebuildDeadline
    : Deadline;

export type DueDeadline = { [N in DeadlineName]: { name: N; deadline: DeadlineOf<N> } }[DeadlineName];

export type SessionDueDeadline = Exclude<DueDeadline, { name: PrebuildDeadlineName }>;

export type PrebuildDueDeadline = Extract<DueDeadline, { name: PrebuildDeadlineName }>;

const isPrebuildDeadline = (due: DueDeadline): due is PrebuildDueDeadline =>
  due.name === "PrebuildDispatch" || due.name === "PrebuildBuild";

export type DeadlineChanges = { [N in DeadlineName]?: DeadlineOf<N> | null };

type Deadlines = { [N in DeadlineName]?: DeadlineOf<N> };

interface Timers {
  tenantId: string;
  sessionId: string;
  deadlines: Deadlines;
}

const TIMERS_KEY = "timers";

export class SessionTimer extends DurableObject<Env> {
  async set(tenantId: string, sessionId: string, changes: DeadlineChanges): Promise<void> {
    const timers = (await this.ctx.storage.get<Timers>(TIMERS_KEY)) ?? { tenantId, sessionId, deadlines: {} };
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
    const tenant = this.env.TENANT.getByName(timers.tenantId);
    for (const reached of due) {
      if (isPrebuildDeadline(reached)) await tenant.prebuildDeadlineReached(timers.tenantId, reached);
      else await tenant.deadlineReached(timers.tenantId, timers.sessionId, reached);
    }
  }

  private async save(timers: Timers): Promise<void> {
    await this.ctx.storage.put(TIMERS_KEY, timers);
    const next = Math.min(...Object.values(timers.deadlines).map((deadline) => deadline.at));
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
}
