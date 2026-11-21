import type { MetricBatchSchema } from "@tumpel/schemas";
import { z } from "zod";
import {
  type ExponentialHistogram,
  ExponentialHistogramSchema,
  histogramOf,
  mergeHistograms,
} from "./metrics-histogram.ts";

export type MetricBatch = z.infer<typeof MetricBatchSchema>;

export type SqlValue = string | number | null;

export interface MetricsSql {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): { toArray(): T[] };
}

export interface MetricsLimits {
  seriesPerTenant: number;
  seriesPerMetric: number;
  dimensionsPerPoint: number;
  dimensionLength: number;
  expiredWindowsPerFlush: number;
  minuteRetentionMs: number;
  hourRetentionMs: number;
  turnPointRetentionMs: number;
  seriesRetentionMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const METRICS_LIMITS: MetricsLimits = {
  seriesPerTenant: 10_000,
  seriesPerMetric: 1_000,
  dimensionsPerPoint: 8,
  dimensionLength: 128,
  expiredWindowsPerFlush: 4,
  minuteRetentionMs: 8 * DAY_MS,
  hourRetentionMs: 400 * DAY_MS,
  turnPointRetentionMs: 90 * DAY_MS,
  seriesRetentionMs: 400 * DAY_MS,
};

export type Resolution = "Minute" | "Hour";

export const BUCKET_MS: Record<Resolution, number> = { Minute: MINUTE_MS, Hour: HOUR_MS };

export const WINDOW_MS: Record<Resolution, number> = { Minute: HOUR_MS, Hour: DAY_MS };

export const windowRetentionMs = (resolution: Resolution, limits: MetricsLimits): number =>
  resolution === "Minute" ? Math.max(limits.minuteRetentionMs, limits.turnPointRetentionMs) : limits.hourRetentionMs;

export const floorTo = (at: number, size: number): number => Math.floor(at / size) * size;

export const OVERFLOW_DIMENSIONS: Readonly<Record<string, string>> = { "otel.metric.overflow": "true" };

export interface NormalisedDimensions {
  entries: [string, string][];
  canonical: string;
}

export const normaliseDimensions = (
  dimensions: Readonly<Record<string, string>>,
  limits: MetricsLimits,
): NormalisedDimensions => {
  const entries = Object.entries(dimensions)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, limits.dimensionsPerPoint)
    .map(([key, value]): [string, string] => [
      key.slice(0, limits.dimensionLength),
      value.slice(0, limits.dimensionLength),
    ]);
  const canonical = `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(",")}}`;
  return { entries, canonical };
};

const RollupSchema = z.object({
  count: z.number().int().nonnegative(),
  sum: z.number(),
  min: z.number(),
  max: z.number(),
  histogram: ExponentialHistogramSchema,
});

const StoredRollupSchema = RollupSchema.extend({ seriesId: z.number().int(), bucketStart: z.number().int() });

const StoredTurnSchema = z.object({
  seriesId: z.number().int(),
  at: z.number().int(),
  turnId: z.string(),
  sessionId: z.string(),
  value: z.number(),
});

const WindowDocSchema = z.object({ rollups: z.array(StoredRollupSchema), turns: z.array(StoredTurnSchema) });

const CatalogSeriesSchema = z.object({
  seriesId: z.number().int(),
  metric: z.string(),
  dimensions: z.string(),
  firstSeenAt: z.number().int(),
  lastSeenAt: z.number().int(),
});

const CatalogSchema = z.object({ nextSeriesId: z.number().int(), series: z.array(CatalogSeriesSchema) });

export type Rollup = z.infer<typeof RollupSchema>;
export type StoredRollup = z.infer<typeof StoredRollupSchema>;
export type StoredTurn = z.infer<typeof StoredTurnSchema>;
export type WindowDoc = z.infer<typeof WindowDocSchema>;
export type CatalogSeries = z.infer<typeof CatalogSeriesSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

export const EMPTY_CATALOG: Catalog = { nextSeriesId: 1, series: [] };
export const EMPTY_WINDOW: WindowDoc = { rollups: [], turns: [] };

const parsedWith = <T>(schema: z.ZodType<T>, stored: string, what: string): T => {
  const parsed = schema.safeParse(JSON.parse(stored));
  if (parsed.success) return parsed.data;
  throw new Error(
    `the stored metrics ${what} does not parse: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}; the metrics store wrote it, so the object is corrupt`,
  );
};

export const parseCatalog = (stored: string): Catalog => parsedWith(CatalogSchema, stored, "catalog");

export const parseWindow = (stored: string): WindowDoc => parsedWith(WindowDocSchema, stored, "window");

const rollupOf = (values: readonly number[]): Rollup => ({
  count: values.length,
  sum: values.reduce((sum, value) => sum + value, 0),
  min: Math.min(...values),
  max: Math.max(...values),
  histogram: histogramOf(values),
});

export const combined = (left: Rollup, right: Rollup): Rollup => ({
  count: left.count + right.count,
  sum: left.sum + right.sum,
  min: Math.min(left.min, right.min),
  max: Math.max(left.max, right.max),
  histogram: mergeHistograms(left.histogram, right.histogram),
});

interface PendingTurn {
  at: number;
  turnId: string;
  sessionId: string;
  value: number;
}

interface PendingSeries {
  metric: string;
  dimensions: NormalisedDimensions;
  firstSeenAt: number;
  lastSeenAt: number;
  minutes: Map<number, number[]>;
  turns: PendingTurn[];
}

export type Pending = Map<string, PendingSeries>;

const pendingSeries = (
  pending: Pending,
  metric: string,
  dimensions: Readonly<Record<string, string>>,
  at: number,
  limits: MetricsLimits,
): PendingSeries => {
  const normalised = normaliseDimensions(dimensions, limits);
  const key = `${metric} ${normalised.canonical}`;
  const held = pending.get(key);
  if (held !== undefined) {
    held.firstSeenAt = Math.min(held.firstSeenAt, at);
    held.lastSeenAt = Math.max(held.lastSeenAt, at);
    return held;
  }
  const created: PendingSeries = {
    metric,
    dimensions: normalised,
    firstSeenAt: at,
    lastSeenAt: at,
    minutes: new Map(),
    turns: [],
  };
  pending.set(key, created);
  return created;
};

const addValue = (series: PendingSeries, at: number, value: number): void => {
  const minute = floorTo(at, MINUTE_MS);
  const values = series.minutes.get(minute);
  if (values === undefined) series.minutes.set(minute, [value]);
  else values.push(value);
};

export const bufferBatch = (pending: Pending, batch: MetricBatch, limits: MetricsLimits): void => {
  for (const { metric, dimensions, at, value } of batch.samples) {
    const atMs = Date.parse(at);
    addValue(pendingSeries(pending, metric, dimensions, atMs, limits), atMs, value);
  }
  for (const { metric, dimensions, at, value, turnId, sessionId } of batch.turns) {
    const atMs = Date.parse(at);
    const series = pendingSeries(pending, metric, dimensions, atMs, limits);
    addValue(series, atMs, value);
    series.turns.push({ at: atMs, turnId, sessionId, value });
  }
};

export interface WindowUpdate {
  resolution: Resolution;
  windowStart: number;
  rollups: StoredRollup[];
  turns: StoredTurn[];
}

const rollupKey = ({ seriesId, bucketStart }: { seriesId: number; bucketStart: number }): string =>
  `${seriesId} ${bucketStart}`;

const turnKey = ({ seriesId, at, turnId }: StoredTurn): string => `${seriesId} ${at} ${turnId}`;

const turnOrder = (left: StoredTurn, right: StoredTurn): number =>
  left.at - right.at ||
  left.seriesId - right.seriesId ||
  (left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0);

const mergedRollups = (left: readonly StoredRollup[], right: readonly StoredRollup[]): StoredRollup[] => {
  const merged = new Map<string, StoredRollup>();
  for (const rollup of [...left, ...right]) {
    const key = rollupKey(rollup);
    const held = merged.get(key);
    merged.set(key, held === undefined ? rollup : { ...held, ...combined(held, rollup) });
  }
  return [...merged.values()].sort((a, b) => a.seriesId - b.seriesId || a.bucketStart - b.bucketStart);
};

const mergedTurns = (left: readonly StoredTurn[], right: readonly StoredTurn[]): StoredTurn[] => {
  const merged = new Map<string, StoredTurn>();
  for (const turn of [...left, ...right]) {
    const key = turnKey(turn);
    if (!merged.has(key)) merged.set(key, turn);
  }
  return [...merged.values()].sort(turnOrder);
};

export const mergeWindow = (stored: WindowDoc, update: WindowUpdate): WindowDoc => ({
  rollups: mergedRollups(stored.rollups, update.rollups),
  turns: mergedTurns(stored.turns, update.turns),
});

export const mergeUpdates = (held: readonly WindowUpdate[], fresh: readonly WindowUpdate[]): WindowUpdate[] => {
  const merged = new Map<string, WindowUpdate>();
  for (const update of [...held, ...fresh]) {
    const key = `${update.resolution} ${update.windowStart}`;
    const known = merged.get(key);
    merged.set(
      key,
      known === undefined
        ? update
        : {
            ...known,
            rollups: mergedRollups(known.rollups, update.rollups),
            turns: mergedTurns(known.turns, update.turns),
          },
    );
  }
  return [...merged.values()].sort((a, b) => a.windowStart - b.windowStart || (a.resolution < b.resolution ? -1 : 1));
};

interface Resolved {
  catalog: Catalog;
  changed: boolean;
  updates: WindowUpdate[];
}

const seriesResolver = (catalog: Catalog, limits: MetricsLimits) => {
  const series = [...catalog.series];
  let nextSeriesId = catalog.nextSeriesId;
  const byKey = new Map(series.map((each, index) => [`${each.metric} ${each.dimensions}`, index]));
  const perMetric = new Map<string, number>();
  for (const each of series) perMetric.set(each.metric, (perMetric.get(each.metric) ?? 0) + 1);
  const overflow = normaliseDimensions(OVERFLOW_DIMENSIONS, limits).canonical;
  let changed = false;
  const create = (metric: string, dimensions: string, firstSeenAt: number, lastSeenAt: number): number => {
    const seriesId = nextSeriesId;
    nextSeriesId += 1;
    byKey.set(`${metric} ${dimensions}`, series.length);
    series.push({ seriesId, metric, dimensions, firstSeenAt, lastSeenAt });
    perMetric.set(metric, (perMetric.get(metric) ?? 0) + 1);
    changed = true;
    return seriesId;
  };
  const seen = (index: number, firstSeenAt: number, lastSeenAt: number): number => {
    const held = series[index];
    if (held === undefined) throw new Error(`the metrics catalog lost series ${index} while resolving a flush`);
    if (firstSeenAt < held.firstSeenAt || lastSeenAt > held.lastSeenAt) {
      series[index] = {
        ...held,
        firstSeenAt: Math.min(held.firstSeenAt, firstSeenAt),
        lastSeenAt: Math.max(held.lastSeenAt, lastSeenAt),
      };
      changed = true;
    }
    return held.seriesId;
  };
  const resolve = (pending: PendingSeries): number => {
    const lastSeenHour = floorTo(pending.lastSeenAt, HOUR_MS);
    const known = byKey.get(`${pending.metric} ${pending.dimensions.canonical}`);
    if (known !== undefined) return seen(known, pending.firstSeenAt, lastSeenHour);
    if (series.length < limits.seriesPerTenant && (perMetric.get(pending.metric) ?? 0) < limits.seriesPerMetric) {
      return create(pending.metric, pending.dimensions.canonical, pending.firstSeenAt, lastSeenHour);
    }
    const spill = byKey.get(`${pending.metric} ${overflow}`);
    if (spill !== undefined) return seen(spill, pending.firstSeenAt, lastSeenHour);
    return create(pending.metric, overflow, pending.firstSeenAt, lastSeenHour);
  };
  const result = (now: number): { catalog: Catalog; changed: boolean } => {
    const kept = series.filter((each) => each.lastSeenAt >= now - limits.seriesRetentionMs);
    return { catalog: { nextSeriesId, series: kept }, changed: changed || kept.length !== series.length };
  };
  return { resolve, result };
};

const windowUpdate = (updates: Map<string, WindowUpdate>, resolution: Resolution, at: number): WindowUpdate => {
  const windowStart = floorTo(at, WINDOW_MS[resolution]);
  const key = `${resolution} ${windowStart}`;
  const held = updates.get(key);
  if (held !== undefined) return held;
  const created: WindowUpdate = { resolution, windowStart, rollups: [], turns: [] };
  updates.set(key, created);
  return created;
};

export const resolvePending = (catalog: Catalog, pending: Pending, now: number, limits: MetricsLimits): Resolved => {
  const resolver = seriesResolver(catalog, limits);
  const updates = new Map<string, WindowUpdate>();
  for (const held of pending.values()) {
    const seriesId = resolver.resolve(held);
    for (const [minute, values] of held.minutes) {
      const rollup = { seriesId, bucketStart: minute, ...rollupOf(values) };
      windowUpdate(updates, "Minute", minute).rollups.push(rollup);
      windowUpdate(updates, "Hour", minute).rollups.push({ ...rollup, bucketStart: floorTo(minute, HOUR_MS) });
    }
    for (const turn of held.turns) windowUpdate(updates, "Minute", turn.at).turns.push({ seriesId, ...turn });
  }
  const { catalog: resolved, changed } = resolver.result(now);
  return { catalog: resolved, changed, updates: mergeUpdates([], [...updates.values()]) };
};

export const declareInstruments = (sql: MetricsSql, instruments: MetricBatch["instruments"], now: number): void => {
  for (const { metric, unit, kind, description } of instruments) {
    sql.exec(
      "INSERT INTO metric (metric, unit, kind, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (metric) DO UPDATE SET unit = excluded.unit, kind = excluded.kind, description = excluded.description, updated_at = excluded.updated_at WHERE unit IS NOT excluded.unit OR kind IS NOT excluded.kind OR description IS NOT excluded.description",
      metric,
      unit,
      kind,
      description,
      now,
      now,
    );
  }
};

export const checkKinds = (sql: MetricsSql, batch: MetricBatch): void => {
  const wanted = new Map<string, string>();
  for (const { metric } of batch.samples) wanted.set(metric, "Sample");
  for (const { metric } of batch.turns) {
    if (wanted.get(metric) === "Sample") {
      throw new Error(`metric ${metric} has both sample and turn points in one batch; send each metric as one kind`);
    }
    wanted.set(metric, "Turn");
  }
  for (const [metric, kind] of wanted) {
    const [declared] = sql.exec<{ kind: string }>("SELECT kind FROM metric WHERE metric = ?", metric).toArray();
    if (declared === undefined) {
      throw new Error(
        `metric ${metric} has no instrument; send its MetricInstrument in the batch with its first points`,
      );
    }
    if (declared.kind !== kind) {
      throw new Error(
        `metric ${metric} is a ${declared.kind} metric but the batch sends it ${kind} points; send its points in ${declared.kind === "Turn" ? "turns" : "samples"}`,
      );
    }
  }
};
