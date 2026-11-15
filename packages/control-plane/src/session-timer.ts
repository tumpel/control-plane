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
  | "HostOffline";

export interface Deadline {
  turnId: string;
  at: number;
}

export type DeadlineChanges = Partial<Record<DeadlineName, Deadline | null>>;

interface Timers {
  tenantId: string;
  sessionId: string;
  deadlines: Partial<Record<DeadlineName, Deadline>>;
}

const TIMERS_KEY = "timers";

export class SessionTimer extends DurableObject<Env> {
  async set(tenantId: string, sessionId: string, changes: DeadlineChanges): Promise<void> {
    const timers = (await this.ctx.storage.get<Timers>(TIMERS_KEY)) ?? { tenantId, sessionId, deadlines: {} };
    for (const [name, deadline] of Object.entries(changes) as [DeadlineName, Deadline | null][]) {
      if (deadline === null) delete timers.deadlines[name];
      else timers.deadlines[name] = deadline;
    }
    await this.save(timers);
  }

  override async alarm(): Promise<void> {
    const timers = await this.ctx.storage.get<Timers>(TIMERS_KEY);
    if (timers === undefined) return;
    const now = Date.now();
    const due = (Object.entries(timers.deadlines) as [DeadlineName, Deadline][]).filter(
      ([, deadline]) => deadline.at <= now,
    );
    for (const [name] of due) delete timers.deadlines[name];
    await this.save(timers);
    const tenant = this.env.TENANT.getByName(timers.tenantId);
    for (const [name, deadline] of due) {
      await tenant.deadlineReached(timers.tenantId, timers.sessionId, name, deadline.turnId);
    }
  }

  private async save(timers: Timers): Promise<void> {
    await this.ctx.storage.put(TIMERS_KEY, timers);
    const next = Math.min(...Object.values(timers.deadlines).map((deadline) => deadline.at));
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
}
