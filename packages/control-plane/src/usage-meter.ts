import type { TenantUsageMeasureSchema, TenantUsageSchema } from "@tumpel/schemas";
import type { z } from "zod";
import {
  NEAR_LIMIT_SHARE,
  type TenantLimit,
  type TenantTier,
  type UsageWindow,
  windowEnd,
  windowStart,
  writes,
} from "./limits.ts";

import type { TenantLimitRefusal } from "./tenant-api.ts";

type Measure = z.infer<typeof TenantUsageMeasureSchema>;
type TenantUsage = z.infer<typeof TenantUsageSchema>;

export type SavedCounter = { measure: Measure; window: UsageWindow; start: number; used: number; signalled: number };

export type Rows = { readonly rowsRead: number; readonly rowsWritten: number };

type Counter = TenantLimit & SavedCounter;

export type UsageSignal = {
  event: "UsageNearLimit" | "UsageLimitReached";
  tier: TenantTier;
  measure: Measure;
  window: UsageWindow;
  used: number;
  limit: number;
  resetsAt: string;
};

const NONE = 0;
const NEAR = 1;
const REACHED = 2;

const counts = (counter: Counter, operation: string | null): boolean => {
  if (operation === null) return counter.measure === "RowsWritten" || counter.measure === "RowsRead";
  if (counter.measure === "Writes" || counter.measure === "RowsWritten") return writes(operation);
  return true;
};

const sameCounter = (a: SavedCounter, b: SavedCounter): boolean => a.measure === b.measure && a.window === b.window;

const countersOf = (limits: TenantLimit[], saved: SavedCounter[], now: number): Counter[] =>
  limits.map((limit) => {
    const start = windowStart(limit.window, now);
    const kept = saved.find(
      (counter) => counter.measure === limit.measure && counter.window === limit.window && counter.start === start,
    );
    return { ...limit, start, used: kept?.used ?? 0, signalled: kept?.signalled ?? NONE };
  });

export class UsageMeter {
  private tier: TenantTier;
  private counters: Counter[];
  private readonly cursors: Rows[];
  private stored: SavedCounter[];
  private savedMinute: number | null = null;
  private unsaved = false;

  constructor(tier: TenantTier, limits: TenantLimit[], stored: SavedCounter[], cursors: Rows[], now: number) {
    this.tier = tier;
    this.cursors = cursors;
    this.stored = stored;
    this.counters = countersOf(limits, stored, now);
  }

  retier(tier: TenantTier, limits: TenantLimit[], now: number): void {
    this.roll(now);
    this.tier = tier;
    this.counters = countersOf(limits, this.saved(now), now);
  }

  private saved(now: number): SavedCounter[] {
    const held = this.counters.map(({ measure, window, start, used, signalled }) => ({
      measure,
      window,
      start,
      used,
      signalled,
    }));
    const kept = this.stored.filter(
      (counter) =>
        counter.start === windowStart(counter.window, now) && !held.some((current) => sameCounter(current, counter)),
    );
    return [...held, ...kept];
  }

  private roll(now: number): void {
    for (const counter of this.counters) {
      const start = windowStart(counter.window, now);
      if (start === counter.start) continue;
      counter.start = start;
      counter.used = 0;
      counter.signalled = NONE;
    }
  }

  spent(operation: string, now: number): TenantLimitRefusal | null {
    this.roll(now);
    const counter = this.counters.find((held) => counts(held, operation) && held.used >= held.limit);
    if (counter === undefined) return null;
    return {
      refusal: "TenantLimitReached",
      tier: this.tier,
      measure: counter.measure,
      window: counter.window,
      used: counter.used,
      limit: counter.limit,
      resetsAt: new Date(windowEnd(counter.window, now)).toISOString(),
    };
  }

  count(operation: string | null, now: number): UsageSignal[] {
    this.roll(now);
    const drained = this.cursors.splice(0);
    const added: Record<Measure, number> = {
      Requests: operation === null ? 0 : 1,
      Writes: operation !== null && writes(operation) ? 1 : 0,
      RowsWritten: drained.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
      RowsRead: drained.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
    };
    this.unsaved = true;
    const signals: UsageSignal[] = [];
    for (const counter of this.counters) {
      counter.used += added[counter.measure];
      const reached = counter.used >= counter.limit ? REACHED : NONE;
      const level = reached || (counter.used >= counter.limit * NEAR_LIMIT_SHARE ? NEAR : NONE);
      if (level <= counter.signalled) continue;
      counter.signalled = level;
      signals.push({
        event: level === REACHED ? "UsageLimitReached" : "UsageNearLimit",
        tier: this.tier,
        measure: counter.measure,
        window: counter.window,
        used: counter.used,
        limit: counter.limit,
        resetsAt: new Date(windowEnd(counter.window, now)).toISOString(),
      });
    }
    return signals;
  }

  usage(now: number): TenantUsage {
    this.roll(now);
    return {
      tier: this.tier,
      counters: this.counters.map((counter) => ({
        measure: counter.measure,
        window: counter.window,
        used: counter.used,
        limit: counter.limit,
        resetsAt: new Date(windowEnd(counter.window, now)).toISOString(),
      })),
    };
  }

  saveDue(now: number): SavedCounter[] | null {
    if (!this.unsaved) return null;
    const minute = windowStart("Minute", now);
    if (minute === this.savedMinute) return null;
    this.savedMinute = minute;
    this.unsaved = false;
    this.stored = this.saved(now);
    return this.stored;
  }
}
