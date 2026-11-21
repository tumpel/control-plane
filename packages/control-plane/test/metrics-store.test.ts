import assert from "node:assert/strict";
import { test } from "node:test";
import { binOf, histogramOfBins, histogramQuantile } from "../src/metrics-histogram.ts";
import {
  dataPointsOf,
  declareInstruments,
  METRICS_LIMITS,
  type MetricBatch,
  metricBatches,
  normaliseDimensions,
  pointCount,
} from "../src/metrics-store.ts";
import { migratedDatabase, SqlStorage } from "./scenarios/harness/runtime.ts";

const T0 = Date.parse("2026-11-16T10:00:00+00:00");

const INSTRUMENTS: MetricBatch["instruments"] = [
  { metric: "host.cpu.busy", unit: "1", kind: "Sample", description: "Share of CPU time the host spent busy" },
  { metric: "turn.cost", unit: "uUSD", kind: "Turn", description: "What a turn cost" },
];

test("a batch past the per-call write limit splits into calls of at most that many points holding every point once", () => {
  const batch: MetricBatch = {
    instruments: INSTRUMENTS,
    samples: Array.from({ length: 300 }, (_, index) => ({
      metric: "host.cpu.busy",
      at: new Date(T0 + index).toISOString(),
      value: index,
      dimensions: {},
    })),
    turns: Array.from({ length: 200 }, (_, index) => ({
      metric: "turn.cost",
      at: new Date(T0 + index).toISOString(),
      value: index,
      dimensions: {},
      turnId: `turn-${index}`,
      sessionId: "session-1",
    })),
  };

  const parts = metricBatches(batch, METRICS_LIMITS);
  assert.ok(parts.every((part) => pointCount(part) <= METRICS_LIMITS.pointsPerRecord));
  assert.deepEqual(
    parts.flatMap((part) => part.samples),
    batch.samples,
  );
  assert.deepEqual(
    parts.flatMap((part) => part.turns),
    batch.turns,
  );
  assert.deepEqual(metricBatches({ ...batch, samples: batch.samples.slice(0, 9) }, METRICS_LIMITS).length, 1);
});

test("a data point carries the tenant as its index, sorted dimension slots, and the time and bin of its value", () => {
  const [sample, turn] = dataPointsOf(
    "tenant-1",
    {
      instruments: INSTRUMENTS,
      samples: [{ metric: "host.cpu.busy", at: new Date(T0).toISOString(), value: 0, dimensions: { hostId: "h1" } }],
      turns: [
        {
          metric: "turn.cost",
          at: new Date(T0 + 1).toISOString(),
          value: 12,
          dimensions: { model: "m", harness: "Pi" },
          turnId: "turn-1",
          sessionId: "session-1",
        },
      ],
    },
    METRICS_LIMITS,
  );
  assert.deepEqual(sample, {
    indexes: ["tenant-1"],
    blobs: ["host.cpu.busy", '{"hostId":"h1"}', "", "", "hostId=h1", "", "", "", "", "", "", ""],
    doubles: [0, T0, 0, 0],
  });
  assert.deepEqual(turn?.blobs.slice(0, 7), [
    "turn.cost",
    '{"harness":"Pi","model":"m"}',
    "turn-1",
    "session-1",
    "harness=Pi",
    "model=m",
    "",
  ]);
  assert.deepEqual(turn?.doubles, [12, T0 + 1, 1, binOf(12).index]);
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
  assert.equal(normaliseDimensions({ b: "2", a: "1" }, METRICS_LIMITS).canonical, '{"a":"1","b":"2"}');
});

test("a histogram of negative and positive bins keeps its quantiles within 5 % of the exact value", () => {
  const values = Array.from({ length: 400 }, (_, index) => (index % 2 === 0 ? -1 : 1) * 2 ** (index / 40));
  const counts = new Map<string, { side: number; index: number; count: number }>();
  for (const point of values) {
    const { side, index } = binOf(point);
    const key = `${side}:${index}`;
    counts.set(key, { side, index, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  const histogram = histogramOfBins([...counts.values()]);
  const bounds = { min: Math.min(...values), max: Math.max(...values) };
  const sorted = [...values].sort((left, right) => left - right);

  for (const quantile of [0.1, 0.5, 0.9]) {
    const exact = sorted[Math.ceil(quantile * sorted.length) - 1] ?? Number.NaN;
    const estimate = histogramQuantile(histogram, quantile, bounds);
    assert.ok(
      Math.abs(estimate - exact) / Math.abs(exact) <= 0.05,
      `p${quantile * 100} ${estimate} is not near ${exact}`,
    );
  }
});

test("a tenant past its metric limit refuses a new metric name and writes no row, while known metrics still declare", () => {
  const storage = new SqlStorage(migratedDatabase(new URL("../migrations/metrics/", import.meta.url)));
  const sql = storage as never;
  const limits = { ...METRICS_LIMITS, instrumentsPerTenant: 2 };
  declareInstruments(sql, INSTRUMENTS, T0, limits);
  const written = storage.totalRowsWritten();

  declareInstruments(sql, INSTRUMENTS, T0, limits);
  assert.throws(
    () =>
      declareInstruments(
        sql,
        [{ metric: "host.invented", unit: "1", kind: "Sample", description: "Invented" }],
        T0,
        limits,
      ),
    /limit of 2 metrics per tenant/,
  );
  assert.equal(storage.totalRowsWritten(), written);
});
