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
type Rows = { readonly rowsRead: number; readonly rowsWritten: number };

export type SavedCounter = { measure: Measure; window: UsageWindow; start: number; used: number; signalled: number };

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

const meteredStorage = (storage: DurableObjectStorage, cursors: Rows[]): DurableObjectStorage =>
  new Proxy(storage, {
    get: (target, property) => {
      if (property !== "sql") {
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return new Proxy(target.sql, {
        get: (inner, name) => {
          const member: unknown = Reflect.get(inner, name);
          if (name !== "exec") return typeof member === "function" ? member.bind(inner) : member;
          return (query: string, ...bindings: unknown[]) => {
            const cursor = inner.exec(query, ...bindings);
            cursors.push(cursor);
            return cursor;
          };
        },
      });
    },
  });

export const meteredState = <Props>(ctx: DurableObjectState<Props>, cursors: Rows[]): DurableObjectState<Props> =>
  new Proxy(ctx, {
    get: (target, property) => {
      if (property === "storage") return meteredStorage(target.storage, cursors);
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const counts = (counter: Counter, operation: string | null): boolean => {
  if (operation === null) return counter.measure === "RowsWritten" || counter.measure === "RowsRead";
  if (counter.measure === "Writes" || counter.measure === "RowsWritten") return writes(operation);
  return true;
};

export class UsageMeter {
  private readonly tier: TenantTier;
  private readonly counters: Counter[];
  private readonly cursors: Rows[];
  private checkpoint: number;

  constructor(tier: TenantTier, limits: TenantLimit[], saved: SavedCounter[], cursors: Rows[], now: number) {
    this.tier = tier;
    this.cursors = cursors;
    this.checkpoint = windowStart("Minute", now);
    this.counters = limits.map((limit) => {
      const start = windowStart(limit.window, now);
      const kept = saved.find(
        (counter) => counter.measure === limit.measure && counter.window === limit.window && counter.start === start,
      );
      return { ...limit, start, used: kept?.used ?? 0, signalled: kept?.signalled ?? NONE };
    });
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

  rolledOver(now: number): SavedCounter[] | null {
    const minute = windowStart("Minute", now);
    if (minute === this.checkpoint) return null;
    this.checkpoint = minute;
    return this.counters.map(({ measure, window, start, used, signalled }) => ({
      measure,
      window,
      start,
      used,
      signalled,
    }));
  }
}
