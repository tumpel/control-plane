import type { MetricBatchSchema } from "@tumpel/schemas";
import type { z } from "zod";
import {
  type ExponentialHistogram,
  histogramOf,
  histogramQuantile,
  mergeHistograms,
  parseHistogram,
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
  expiredRowsPerWrite: number;
  minuteRetentionMs: number;
  hourRetentionMs: number;
  turnPointRetentionMs: number;
  seriesRetentionMs: number;
}

const DAY_MS = 86_400_000;

export const METRICS_LIMITS: MetricsLimits = {
  seriesPerTenant: 10_000,
  seriesPerMetric: 1_000,
  dimensionsPerPoint: 8,
  dimensionLength: 128,
  expiredRowsPerWrite: 500,
  minuteRetentionMs: 8 * DAY_MS,
  hourRetentionMs: 400 * DAY_MS,
  turnPointRetentionMs: 90 * DAY_MS,
  seriesRetentionMs: 400 * DAY_MS,
};

export type Resolution = "Minute" | "Hour";

const BUCKET_MS: Record<Resolution, number> = { Minute: 60_000, Hour: 3_600_000 };

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

const expire = (sql: MetricsSql, now: number, limits: MetricsLimits): void => {
  const rows = limits.expiredRowsPerWrite;
  for (const [resolution, retention] of [
    ["Minute", limits.minuteRetentionMs],
    ["Hour", limits.hourRetentionMs],
  ] as const) {
    sql.exec(
      "DELETE FROM rollup WHERE (resolution, series_id, bucket_start) IN (SELECT resolution, series_id, bucket_start FROM rollup WHERE resolution = ? AND bucket_start < ? LIMIT ?)",
      resolution,
      now - retention,
      rows,
    );
  }
  sql.exec(
    "DELETE FROM turn_point WHERE (series_id, at, turn_id) IN (SELECT series_id, at, turn_id FROM turn_point WHERE at < ? LIMIT ?)",
    now - limits.turnPointRetentionMs,
    rows,
  );
  sql.exec(
    "DELETE FROM series WHERE series_id IN (SELECT s.series_id FROM metric m CROSS JOIN series s ON s.metric = m.metric AND s.last_seen_at < ? LIMIT ?)",
    now - limits.seriesRetentionMs,
    rows,
  );
};

const declareInstruments = (sql: MetricsSql, instruments: MetricBatch["instruments"], now: number): void => {
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

const checkKinds = (sql: MetricsSql, batch: MetricBatch): void => {
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

interface SeriesCounts {
  tenant: number | undefined;
  perMetric: Map<string, number>;
}

const insertSeries = (sql: MetricsSql, metric: string, dimensions: NormalisedDimensions, at: number): number => {
  const [inserted] = sql
    .exec<{ series_id: number }>(
      "INSERT INTO series (metric, dimensions, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) RETURNING series_id",
      metric,
      dimensions.canonical,
      at,
      at,
    )
    .toArray();
  if (inserted === undefined) throw new Error(`the series insert for metric ${metric} returned no series_id`);
  for (const [dimension, value] of dimensions.entries) {
    sql.exec(
      "INSERT INTO series_dimension (dimension, value, series_id) VALUES (?, ?, ?)",
      dimension,
      value,
      inserted.series_id,
    );
  }
  return inserted.series_id;
};

const existingSeries = (sql: MetricsSql, metric: string, canonical: string): number | undefined =>
  sql
    .exec<{ series_id: number }>("SELECT series_id FROM series WHERE metric = ? AND dimensions = ?", metric, canonical)
    .toArray()[0]?.series_id;

type SeriesResolver = (metric: string, dimensions: NormalisedDimensions, at: number) => number;

const seriesResolver = (sql: MetricsSql, limits: MetricsLimits): SeriesResolver => {
  const counts: SeriesCounts = { tenant: undefined, perMetric: new Map() };
  const overflow = normaliseDimensions(OVERFLOW_DIMENSIONS, limits);
  const tenantCount = (): number => {
    counts.tenant ??= sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM series").toArray()[0]?.count ?? 0;
    return counts.tenant;
  };
  const metricCount = (metric: string): number => {
    const known = counts.perMetric.get(metric);
    if (known !== undefined) return known;
    const counted =
      sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM series WHERE metric = ?", metric).toArray()[0]
        ?.count ?? 0;
    counts.perMetric.set(metric, counted);
    return counted;
  };
  const created = (metric: string, dimensions: NormalisedDimensions, at: number): number => {
    const seriesId = insertSeries(sql, metric, dimensions, at);
    counts.tenant = tenantCount() + 1;
    counts.perMetric.set(metric, metricCount(metric) + 1);
    return seriesId;
  };
  return (metric: string, dimensions: NormalisedDimensions, at: number): number => {
    const existing = existingSeries(sql, metric, dimensions.canonical);
    if (existing !== undefined) return existing;
    if (tenantCount() < limits.seriesPerTenant && metricCount(metric) < limits.seriesPerMetric) {
      return created(metric, dimensions, at);
    }
    return existingSeries(sql, metric, overflow.canonical) ?? created(metric, overflow, at);
  };
};

interface RecordedPoint {
  seriesId: number;
  atMs: number;
}

interface Aggregate {
  resolution: Resolution;
  seriesId: number;
  bucketStart: number;
  values: number[];
}

interface Rollup {
  count: number;
  sum: number;
  min: number;
  max: number;
  histogram: ExponentialHistogram;
}

type RollupRow = { count: number; sum: number; min: number; max: number; histogram: string };

const rollupOf = (values: readonly number[]): Rollup => ({
  count: values.length,
  sum: values.reduce((sum, value) => sum + value, 0),
  min: Math.min(...values),
  max: Math.max(...values),
  histogram: histogramOf(values),
});

const combined = (stored: RollupRow, fresh: Rollup): Rollup => ({
  count: stored.count + fresh.count,
  sum: stored.sum + fresh.sum,
  min: Math.min(stored.min, fresh.min),
  max: Math.max(stored.max, fresh.max),
  histogram: mergeHistograms(parseHistogram(stored.histogram), fresh.histogram),
});

const writeRollup = (sql: MetricsSql, { resolution, seriesId, bucketStart, values }: Aggregate): void => {
  const [stored] = sql
    .exec<RollupRow>(
      "SELECT count, sum, min, max, histogram FROM rollup WHERE resolution = ? AND series_id = ? AND bucket_start = ?",
      resolution,
      seriesId,
      bucketStart,
    )
    .toArray();
  const fresh = rollupOf(values);
  const rollup = stored === undefined ? fresh : combined(stored, fresh);
  sql.exec(
    "INSERT INTO rollup (resolution, series_id, bucket_start, count, sum, min, max, histogram) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (resolution, series_id, bucket_start) DO UPDATE SET count = excluded.count, sum = excluded.sum, min = excluded.min, max = excluded.max, histogram = excluded.histogram",
    resolution,
    seriesId,
    bucketStart,
    rollup.count,
    rollup.sum,
    rollup.min,
    rollup.max,
    JSON.stringify(rollup.histogram),
  );
};

export const recordBatch = (sql: MetricsSql, batch: MetricBatch, now: number, limits: MetricsLimits): void => {
  expire(sql, now, limits);
  declareInstruments(sql, batch.instruments, now);
  checkKinds(sql, batch);
  const resolve = seriesResolver(sql, limits);
  const lastSeen = new Map<number, number>();
  const aggregates = new Map<string, Aggregate>();
  const point = (
    metric: string,
    dimensions: Readonly<Record<string, string>>,
    at: string,
    value: number,
  ): RecordedPoint => {
    const atMs = Date.parse(at);
    const seriesId = resolve(metric, normaliseDimensions(dimensions, limits), atMs);
    lastSeen.set(seriesId, Math.max(lastSeen.get(seriesId) ?? atMs, atMs));
    for (const resolution of ["Minute", "Hour"] as const) {
      const bucketStart = Math.floor(atMs / BUCKET_MS[resolution]) * BUCKET_MS[resolution];
      const key = `${resolution} ${seriesId} ${bucketStart}`;
      const aggregate = aggregates.get(key);
      if (aggregate === undefined) aggregates.set(key, { resolution, seriesId, bucketStart, values: [value] });
      else aggregate.values.push(value);
    }
    return { seriesId, atMs };
  };
  for (const { metric, dimensions, at, value } of batch.samples) point(metric, dimensions, at, value);
  for (const { metric, dimensions, at, value, turnId, sessionId } of batch.turns) {
    const { seriesId, atMs } = point(metric, dimensions, at, value);
    sql.exec(
      "INSERT OR IGNORE INTO turn_point (series_id, at, turn_id, session_id, value) VALUES (?, ?, ?, ?, ?)",
      seriesId,
      atMs,
      turnId,
      sessionId,
      value,
    );
  }
  for (const [seriesId, at] of lastSeen) {
    sql.exec("UPDATE series SET last_seen_at = MAX(last_seen_at, ?) WHERE series_id = ?", at, seriesId);
  }
  for (const aggregate of aggregates.values()) writeRollup(sql, aggregate);
};

export interface RollupPoint {
  dimensions: string;
  bucketStart: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p99: number;
}

export const readRollups = (
  sql: MetricsSql,
  metric: string,
  resolution: Resolution,
  from: number,
  to: number,
): RollupPoint[] =>
  sql
    .exec<RollupRow & { dimensions: string; bucket_start: number }>(
      "SELECT s.dimensions, r.bucket_start, r.count, r.sum, r.min, r.max, r.histogram FROM series s JOIN rollup r ON r.resolution = ? AND r.series_id = s.series_id AND r.bucket_start >= ? AND r.bucket_start < ? WHERE s.metric = ? ORDER BY s.dimensions, r.bucket_start",
      resolution,
      from,
      to,
      metric,
    )
    .toArray()
    .map((row) => {
      const histogram = parseHistogram(row.histogram);
      const bounds = { min: row.min, max: row.max };
      return {
        dimensions: row.dimensions,
        bucketStart: row.bucket_start,
        count: row.count,
        sum: row.sum,
        min: row.min,
        max: row.max,
        p50: histogramQuantile(histogram, 0.5, bounds),
        p90: histogramQuantile(histogram, 0.9, bounds),
        p99: histogramQuantile(histogram, 0.99, bounds),
      };
    });
