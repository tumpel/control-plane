import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  HISTOGRAM_MAX_BUCKETS,
  HISTOGRAM_START_SCALE,
  histogramOf,
  mergeHistograms,
} from "../src/metrics-histogram.ts";
import {
  METRICS_LIMITS,
  type MetricBatch,
  type MetricsLimits,
  type MetricsSql,
  normaliseDimensions,
  readRollups,
  recordBatch,
} from "../src/metrics-store.ts";

const DDL = readFileSync(new URL("../migrations/metrics/0001_metrics.sql", import.meta.url), "utf8");
const T0 = Date.parse("2026-11-16T10:00:00+00:00");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const store = (): MetricsSql => {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  return {
    exec: <T>(query: string, ...bindings: (string | number | null)[]) => {
      const rows = db.prepare(query).all(...bindings) as T[];
      return { toArray: () => rows };
    },
  };
};

const INSTRUMENTS: MetricBatch["instruments"] = [
  { metric: "host.cpu.busy", unit: "1", kind: "Sample", description: "Share of CPU time the host spent busy" },
  { metric: "turn.cost", unit: "uUSD", kind: "Turn", description: "What a turn cost" },
];

const samples = (
  points: readonly { at: number; value: number; dimensions?: Record<string, string> }[],
): MetricBatch => ({
  instruments: INSTRUMENTS,
  samples: points.map(({ at, value, dimensions }) => ({
    metric: "host.cpu.busy",
    at: new Date(at).toISOString(),
    value,
    dimensions: dimensions ?? { hostId: "host-1" },
  })),
  turns: [],
});

const exactQuantile = (values: readonly number[], quantile: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(1, Math.ceil(quantile * sorted.length)) - 1] ?? Number.NaN;
};

test("rollups add count, sum, min and max across batches into minute and hour rows", () => {
  const sql = store();
  recordBatch(
    sql,
    samples([
      { at: T0 + 1_000, value: 0.5 },
      { at: T0 + 2_000, value: 0.25 },
    ]),
    T0,
    METRICS_LIMITS,
  );
  recordBatch(
    sql,
    samples([
      { at: T0 + 30_000, value: 0.75 },
      { at: T0 + MINUTE + 5_000, value: 1 },
    ]),
    T0,
    METRICS_LIMITS,
  );

  const minutes = readRollups(sql, "host.cpu.busy", "Minute", T0, T0 + HOUR);
  assert.deepEqual(
    minutes.map(({ bucketStart, count, sum, min, max }) => ({ bucketStart, count, sum, min, max })),
    [
      { bucketStart: T0, count: 3, sum: 1.5, min: 0.25, max: 0.75 },
      { bucketStart: T0 + MINUTE, count: 1, sum: 1, min: 1, max: 1 },
    ],
  );
  const hours = readRollups(sql, "host.cpu.busy", "Hour", T0, T0 + HOUR);
  assert.deepEqual(
    hours.map(({ bucketStart, count, sum, min, max }) => ({ bucketStart, count, sum, min, max })),
    [{ bucketStart: T0, count: 4, sum: 2.5, min: 0.25, max: 1 }],
  );
});

test("percentiles from merged rollup histograms stay within 5 % of the exact value", () => {
  const sql = store();
  const values = Array.from({ length: 3_000 }, (_, index) => 1.5 ** ((index * 7919) % 28) * (1 + (index % 13) / 13));
  for (let start = 0; start < values.length; start += 500) {
    recordBatch(
      sql,
      samples(values.slice(start, start + 500).map((value, offset) => ({ at: T0 + (start + offset) * 1_000, value }))),
      T0,
      METRICS_LIMITS,
    );
  }

  const [hour] = readRollups(sql, "host.cpu.busy", "Hour", T0, T0 + HOUR);
  assert.ok(hour);
  assert.equal(hour.count, values.length);
  for (const [quantile, estimate] of [
    [0.5, hour.p50],
    [0.9, hour.p90],
    [0.99, hour.p99],
  ] as const) {
    const exact = exactQuantile(values, quantile);
    assert.ok(
      Math.abs(estimate - exact) / exact <= 0.05,
      `p${quantile * 100} ${estimate} is not within 5 % of ${exact}`,
    );
  }
});

test("past the series caps, points land in the metric's overflow series", () => {
  const sql = store();
  const limits: MetricsLimits = { ...METRICS_LIMITS, seriesPerMetric: 2 };
  recordBatch(
    sql,
    samples(
      ["host-1", "host-2", "host-3", "host-4", "host-1"].map((hostId) => ({
        at: T0,
        value: 1,
        dimensions: { hostId },
      })),
    ),
    T0,
    limits,
  );

  const busy = readRollups(sql, "host.cpu.busy", "Minute", T0, T0 + MINUTE);
  assert.deepEqual(
    busy.map(({ dimensions, count }) => ({ dimensions, count })),
    [
      { dimensions: '{"hostId":"host-1"}', count: 2 },
      { dimensions: '{"hostId":"host-2"}', count: 1 },
      { dimensions: '{"otel.metric.overflow":"true"}', count: 2 },
    ],
  );
});

test("a metric whose first series would pass the tenant cap starts in its overflow series", () => {
  const sql = store();
  const limits: MetricsLimits = { ...METRICS_LIMITS, seriesPerTenant: 1 };
  recordBatch(sql, samples([{ at: T0, value: 1 }]), T0, limits);
  recordBatch(
    sql,
    {
      instruments: INSTRUMENTS,
      samples: [],
      turns: [
        {
          metric: "turn.cost",
          at: new Date(T0).toISOString(),
          value: 7,
          dimensions: { harness: "Pi" },
          turnId: "turn-1",
          sessionId: "session-1",
        },
      ],
    },
    T0,
    limits,
  );

  assert.deepEqual(
    readRollups(sql, "turn.cost", "Minute", T0, T0 + MINUTE).map(({ dimensions, sum }) => ({ dimensions, sum })),
    [{ dimensions: '{"otel.metric.overflow":"true"}', sum: 7 }],
  );
});

test("each write deletes a bounded number of expired rows per table", () => {
  const sql = store();
  const limits: MetricsLimits = { ...METRICS_LIMITS, expiredRowsPerWrite: 2 };
  recordBatch(sql, samples([0, 1, 2].map((minute) => ({ at: T0 + minute * MINUTE, value: 1 }))), T0, limits);
  const later = T0 + limits.minuteRetentionMs + HOUR;
  const minutes = (): number => readRollups(sql, "host.cpu.busy", "Minute", T0, T0 + HOUR).length;
  const hours = (): number => readRollups(sql, "host.cpu.busy", "Hour", T0, T0 + HOUR).length;

  recordBatch(sql, samples([]), later, limits);
  assert.equal(minutes(), 1);
  recordBatch(sql, samples([]), later, limits);
  assert.equal(minutes(), 0);
  assert.equal(hours(), 1);

  recordBatch(sql, samples([]), T0 + limits.hourRetentionMs + HOUR, limits);
  assert.equal(hours(), 0);
});

test("turn points expire after their retention and unseen series after theirs", () => {
  const sql = store();
  recordBatch(
    sql,
    {
      instruments: INSTRUMENTS,
      samples: [],
      turns: [
        {
          metric: "turn.cost",
          at: new Date(T0).toISOString(),
          value: 3,
          dimensions: { harness: "Pi" },
          turnId: "turn-1",
          sessionId: "session-1",
        },
      ],
    },
    T0,
    METRICS_LIMITS,
  );
  const count = (query: string): number => sql.exec<{ count: number }>(query).toArray()[0]?.count ?? -1;

  recordBatch(sql, samples([]), T0 + METRICS_LIMITS.turnPointRetentionMs - DAY, METRICS_LIMITS);
  assert.equal(count("SELECT COUNT(*) AS count FROM turn_point"), 1);
  recordBatch(sql, samples([]), T0 + METRICS_LIMITS.turnPointRetentionMs + DAY, METRICS_LIMITS);
  assert.equal(count("SELECT COUNT(*) AS count FROM turn_point"), 0);
  assert.equal(count("SELECT COUNT(*) AS count FROM series"), 1);

  recordBatch(sql, samples([]), T0 + METRICS_LIMITS.seriesRetentionMs + DAY, METRICS_LIMITS);
  assert.equal(count("SELECT COUNT(*) AS count FROM series"), 0);
  assert.equal(count("SELECT COUNT(*) AS count FROM series_dimension"), 0);
});

test("dimensions are sorted by key and bounded in count and length", () => {
  const many = Object.fromEntries(
    Array.from({ length: METRICS_LIMITS.dimensionsPerPoint + 2 }, (_, index) => [`d${9 - index}`, `${index}`]),
  );
  const normalised = normaliseDimensions(
    { ...many, a: "x".repeat(METRICS_LIMITS.dimensionLength + 50) },
    METRICS_LIMITS,
  );

  assert.equal(normalised.entries.length, METRICS_LIMITS.dimensionsPerPoint);
  assert.deepEqual(
    normalised.entries.map(([key]) => key),
    ["a", "d0", "d1", "d2", "d3", "d4", "d5", "d6"],
  );
  assert.equal(normalised.entries[0]?.[1].length, METRICS_LIMITS.dimensionLength);
  assert.equal(
    normaliseDimensions({ model: "m", harness: "Pi" }, METRICS_LIMITS).canonical,
    normaliseDimensions({ harness: "Pi", model: "m" }, METRICS_LIMITS).canonical,
  );
  assert.equal(normaliseDimensions({ b: "2", a: "1" }, METRICS_LIMITS).canonical, '{"a":"1","b":"2"}');
});

test("merging histograms downscales to fit and matches one histogram of every value", () => {
  const small = Array.from({ length: 200 }, (_, index) => 1 + index / 100);
  const wide = Array.from({ length: 200 }, (_, index) => 2 ** (index / 5) * 1_000);
  const merged = mergeHistograms(histogramOf(small), histogramOf(wide));

  assert.ok(merged.positive.bucketCounts.length <= HISTOGRAM_MAX_BUCKETS);
  assert.ok(merged.scale < HISTOGRAM_START_SCALE);
  assert.deepEqual(merged, histogramOf([...small, ...wide]));
});
