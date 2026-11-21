import type { MetricBatchSchema } from "@tumpel/schemas";
import type { z } from "zod";
import { binOf } from "./metrics-histogram.ts";

export type MetricBatch = z.infer<typeof MetricBatchSchema>;

export type SqlValue = string | number | null;

export interface MetricsSql {
  exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): { toArray(): T[] };
}

export interface MetricsLimits {
  dimensionsPerPoint: number;
  dimensionLength: number;
  retentionMs: number;
  pointsPerRecord: number;
  rowsPerQuery: number;
  instrumentsPerTenant: number;
}

const DAY_MS = 86_400_000;

export const METRICS_LIMITS: MetricsLimits = {
  dimensionsPerPoint: 8,
  dimensionLength: 128,
  retentionMs: 90 * DAY_MS,
  pointsPerRecord: 250,
  rowsPerQuery: 10_000,
  instrumentsPerTenant: 1_000,
};

export const DIMENSION_SLOTS = 8;
export const FIRST_SLOT_BLOB = 5;

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
    .slice(0, Math.min(limits.dimensionsPerPoint, DIMENSION_SLOTS))
    .map(([key, value]): [string, string] => [
      key.slice(0, limits.dimensionLength),
      value.slice(0, limits.dimensionLength),
    ]);
  const canonical = `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(",")}}`;
  return { entries, canonical };
};

export interface MetricDataPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

interface Point {
  metric: string;
  at: string;
  value: number;
  dimensions: Record<string, string>;
}

const dataPointOf = (
  tenantId: string,
  { metric, at, value, dimensions }: Point,
  turn: { turnId: string; sessionId: string } | undefined,
  limits: MetricsLimits,
): MetricDataPoint => {
  const { entries, canonical } = normaliseDimensions(dimensions, limits);
  const slots = Array.from({ length: DIMENSION_SLOTS }, (_, slot) => {
    const entry = entries[slot];
    return entry === undefined ? "" : `${entry[0]}=${entry[1]}`;
  });
  const { side, index } = binOf(value);
  return {
    indexes: [tenantId],
    blobs: [metric, canonical, turn?.turnId ?? "", turn?.sessionId ?? "", ...slots],
    doubles: [value, Date.parse(at), side, index],
  };
};

export const dataPointsOf = (tenantId: string, batch: MetricBatch, limits: MetricsLimits): MetricDataPoint[] => [
  ...batch.samples.map((point) => dataPointOf(tenantId, point, undefined, limits)),
  ...batch.turns.map((point) => dataPointOf(tenantId, point, point, limits)),
];

export const pointCount = (batch: MetricBatch): number => batch.samples.length + batch.turns.length;

export const metricBatches = (batch: MetricBatch, limits: MetricsLimits): MetricBatch[] => {
  const size = limits.pointsPerRecord;
  if (pointCount(batch) <= size) return [batch];
  const chunks: MetricBatch[] = [];
  for (let start = 0; start < batch.samples.length; start += size) {
    chunks.push({ instruments: batch.instruments, samples: batch.samples.slice(start, start + size), turns: [] });
  }
  for (let start = 0; start < batch.turns.length; start += size) {
    chunks.push({ instruments: batch.instruments, samples: [], turns: batch.turns.slice(start, start + size) });
  }
  return chunks;
};

export const declareInstruments = (
  sql: MetricsSql,
  instruments: MetricBatch["instruments"],
  now: number,
  limits: MetricsLimits,
): void => {
  for (const { metric, unit, kind, description } of instruments) {
    if (sql.exec<{ metric: string }>("SELECT metric FROM metric WHERE metric = ?", metric).toArray().length > 0)
      continue;
    const [declared] = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM metric").toArray();
    if ((declared?.count ?? 0) >= limits.instrumentsPerTenant) {
      throw new Error(
        `metric ${metric} would pass the limit of ${limits.instrumentsPerTenant} metrics per tenant; send points only for the metrics the host already declared`,
      );
    }
    sql.exec(
      "INSERT INTO metric (metric, unit, kind, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (metric) DO NOTHING",
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
