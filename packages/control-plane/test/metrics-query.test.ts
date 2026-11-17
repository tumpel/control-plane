import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  MAX_GROUPS,
  OTHER_GROUP,
  type Outcome,
  planBuckets,
  querySeries,
  readCatalog,
  readTurns,
} from "../src/metrics-query.ts";
import { METRICS_LIMITS, type MetricBatch, type MetricsSql, recordBatch } from "../src/metrics-store.ts";

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

interface Cost {
  at: number;
  value: number;
  dimensions: Record<string, string>;
  turnId?: string;
  sessionId?: string;
}

const costs = (sql: MetricsSql, points: readonly Cost[]): void =>
  recordBatch(
    sql,
    {
      instruments: INSTRUMENTS,
      samples: [],
      turns: points.map(({ at, value, dimensions, turnId, sessionId }, index) => ({
        metric: "turn.cost",
        at: new Date(at).toISOString(),
        value,
        dimensions,
        turnId: turnId ?? `turn-${index}`,
        sessionId: sessionId ?? "session-1",
      })),
    },
    T0,
    METRICS_LIMITS,
  );

const iso = (at: number): string => new Date(at).toISOString();

const value = <T>(outcome: Outcome<T>): T => {
  assert.ok(outcome.ok, outcome.ok ? "" : `${outcome.problem.title}: ${outcome.problem.detail}`);
  return outcome.value;
};

const FLEET: readonly Cost[] = [
  { at: T0, value: 10, dimensions: { harness: "Pi", model: "a" } },
  { at: T0 + MINUTE, value: 20, dimensions: { harness: "Pi", model: "b" } },
  { at: T0 + 2 * MINUTE, value: 40, dimensions: { harness: "Codex", model: "a" } },
  { at: T0 + 3 * MINUTE, value: 80, dimensions: { harness: "OpenCode", model: "a" } },
];

test("the catalog lists the metrics seen in the window with each dimension's values and series counts", () => {
  const sql = store();
  costs(sql, FLEET);
  recordBatch(
    sql,
    {
      instruments: INSTRUMENTS,
      samples: [{ metric: "host.cpu.busy", at: iso(T0 - 2 * DAY), value: 0.5, dimensions: { hostId: "host-1" } }],
      turns: [],
    },
    T0,
    METRICS_LIMITS,
  );

  const catalog = value(readCatalog(sql, { from: iso(T0 - HOUR), to: iso(T0 + HOUR) }));
  assert.deepEqual(catalog.metrics, [
    {
      metric: "turn.cost",
      unit: "uUSD",
      kind: "Turn",
      description: "What a turn cost",
      facets: [
        {
          dimension: "harness",
          values: [
            { value: "Codex", seriesCount: 1 },
            { value: "OpenCode", seriesCount: 1 },
            { value: "Pi", seriesCount: 2 },
          ],
        },
        {
          dimension: "model",
          values: [
            { value: "a", seriesCount: 3 },
            { value: "b", seriesCount: 1 },
          ],
        },
      ],
    },
  ]);

  const filtered = value(readCatalog(sql, { from: iso(T0 - HOUR), to: iso(T0 + HOUR), filter: ["model:b"] }));
  assert.deepEqual(
    filtered.metrics[0]?.facets.map(({ dimension, values }) => [dimension, values.map((entry) => entry.value)]),
    [
      ["harness", ["Pi"]],
      ["model", ["b"]],
    ],
  );
});

test("a filter ORs the values of one dimension and ANDs different dimensions", () => {
  const sql = store();
  costs(sql, FLEET);
  const window = { from: iso(T0), to: iso(T0 + HOUR), bucket: "Hour" as const };
  const sum = (filter: string[]): number | undefined =>
    value(querySeries(sql, "turn.cost", { ...window, filter }, T0, METRICS_LIMITS)).series[0]?.points[0]?.sum;

  assert.equal(sum([]), 150);
  assert.equal(sum(["harness:Pi", "harness:Codex"]), 70);
  assert.equal(sum(["harness:Pi", "harness:Codex", "model:a"]), 50);
  assert.equal(sum(["harness:Nope"]), undefined);
  const refused = querySeries(sql, "turn.cost", { ...window, filter: ["harness"] }, T0, METRICS_LIMITS);
  assert.ok(!refused.ok);
  assert.equal(refused.problem.code, "InvalidRequest");
});

test("group-by keys each series by its dimension values and folds groups past the cap into Other", () => {
  const sql = store();
  costs(sql, FLEET);
  const window = { from: iso(T0), to: iso(T0 + HOUR), bucket: "Hour" as const };

  const byHarness = value(querySeries(sql, "turn.cost", { ...window, groupBy: ["harness"] }, T0, METRICS_LIMITS));
  assert.deepEqual(
    byHarness.series.map(({ group, points }) => ({ group, count: points[0]?.count, sum: points[0]?.sum })),
    [
      { group: { harness: "Pi" }, count: 2, sum: 30 },
      { group: { harness: "Codex" }, count: 1, sum: 40 },
      { group: { harness: "OpenCode" }, count: 1, sum: 80 },
    ],
  );
  const byBoth = value(querySeries(sql, "turn.cost", { ...window, groupBy: ["harness", "model"] }, T0, METRICS_LIMITS));
  assert.equal(byBoth.series.length, 4);

  const crowd = store();
  costs(
    crowd,
    Array.from({ length: MAX_GROUPS + 5 }, (_, index) => ({
      at: T0,
      value: 1,
      dimensions: { model: `m${String(index).padStart(2, "0")}` },
    })),
  );
  const folded = value(querySeries(crowd, "turn.cost", { ...window, groupBy: ["model"] }, T0, METRICS_LIMITS));
  assert.equal(folded.series.length, MAX_GROUPS + 1);
  assert.deepEqual(folded.series.at(-1)?.group, { model: OTHER_GROUP });
  assert.equal(folded.series.at(-1)?.points[0]?.count, 5);
});

test("Day buckets start at midnight in the offset of from and sum hour rollups", () => {
  const sql = store();
  costs(sql, [
    { at: Date.parse("2026-11-15T23:30:00+02:00"), value: 1, dimensions: { harness: "Pi" } },
    { at: Date.parse("2026-11-16T00:30:00+02:00"), value: 2, dimensions: { harness: "Pi" } },
    { at: Date.parse("2026-11-16T23:59:00+02:00"), value: 4, dimensions: { harness: "Pi" } },
  ]);

  const days = value(
    querySeries(
      sql,
      "turn.cost",
      { from: "2026-11-15T12:00:00+02:00", to: "2026-11-17T00:00:00+02:00", bucket: "Day" },
      T0,
      METRICS_LIMITS,
    ),
  );
  assert.deepEqual(
    days.series[0]?.points.map(({ bucketStart, count, sum }) => ({ bucketStart, count, sum })),
    [
      { bucketStart: "2026-11-15T00:00:00+02:00", count: 1, sum: 1 },
      { bucketStart: "2026-11-16T00:00:00+02:00", count: 2, sum: 6 },
    ],
  );
});

test("percentiles of a group come from its merged rollup histograms within 5 % of the exact value", () => {
  const sql = store();
  const values = Array.from({ length: 1_000 }, (_, index) => 1.3 ** (index % 40) * (1 + (index % 7) / 7));
  for (let start = 0; start < values.length; start += 250) {
    costs(
      sql,
      values.slice(start, start + 250).map((cost, offset) => ({
        at: T0 + (start + offset) * 3_000,
        value: cost,
        dimensions: { harness: `h${offset % 4}` },
      })),
    );
  }

  const [point] =
    value(querySeries(sql, "turn.cost", { from: iso(T0), to: iso(T0 + 2 * HOUR), bucket: "Day" }, T0, METRICS_LIMITS))
      .series[0]?.points ?? [];
  assert.ok(point);
  assert.equal(point.count, values.length);
  const sorted = [...values].sort((left, right) => left - right);
  for (const [quantile, estimate] of [
    [0.5, point.p50],
    [0.9, point.p90],
    [0.99, point.p99],
  ] as const) {
    const exact = sorted[Math.ceil(quantile * sorted.length) - 1] ?? Number.NaN;
    assert.ok(Math.abs(estimate - exact) / exact <= 0.05, `p${quantile * 100} ${estimate} is not near ${exact}`);
  }
});

test("a range past 500 buckets or Minute buckets past retention is refused with a range that fits", () => {
  const tooMany = planBuckets(
    "Minute",
    { from: "2026-11-16T10:00:00+01:00", to: "2026-11-17T10:00:00+01:00" },
    T0,
    METRICS_LIMITS,
  );
  assert.ok(!tooMany.ok);
  assert.equal(tooMany.problem.code, "MetricRangeTooLarge");
  assert.match(tooMany.problem.fix, /from 2026-11-16T10:00:00\+01:00 to 2026-11-16T18:20:00\+01:00/);

  const tooOld = planBuckets("Minute", { from: iso(T0 - 9 * DAY), to: iso(T0 - 9 * DAY + HOUR) }, T0, METRICS_LIMITS);
  assert.ok(!tooOld.ok);
  assert.match(tooOld.problem.fix, /from 2026-11-08T10:00:00Z to 2026-11-08T10:01:00Z/);

  assert.ok(planBuckets("Hour", { from: iso(T0 - 20 * DAY), to: iso(T0) }, T0, METRICS_LIMITS).ok);
  const backwards = planBuckets("Hour", { from: iso(T0), to: iso(T0) }, T0, METRICS_LIMITS);
  assert.ok(!backwards.ok);
  assert.equal(backwards.problem.code, "InvalidRequest");
});

test("a metric the store lacks is refused MetricNotFound", () => {
  const sql = store();
  const window = { from: iso(T0), to: iso(T0 + HOUR) };
  const series = querySeries(sql, "turn.nope", { ...window, bucket: "Hour" }, T0, METRICS_LIMITS);
  const turns = readTurns(sql, "turn.nope", window);
  assert.ok(!series.ok && !turns.ok);
  assert.equal(series.problem.code, "MetricNotFound");
  assert.equal(turns.problem.code, "MetricNotFound");
});

test("turns page through a metric's turn points in order, by session and filter", () => {
  const sql = store();
  costs(sql, [
    ...FLEET,
    {
      at: T0 + 4 * MINUTE,
      value: 5,
      dimensions: { harness: "Pi", model: "a" },
      turnId: "turn-9",
      sessionId: "session-2",
    },
  ]);
  const window = { from: "2026-11-16T11:00:00+01:00", to: iso(T0 + HOUR) };

  const first = value(readTurns(sql, "turn.cost", window, 3));
  assert.deepEqual(
    first.points.map(({ turnId, at }) => [turnId, at]),
    [
      ["turn-0", "2026-11-16T11:00:00+01:00"],
      ["turn-1", "2026-11-16T11:01:00+01:00"],
      ["turn-2", "2026-11-16T11:02:00+01:00"],
    ],
  );
  assert.equal(first.finished, false);
  const second = value(readTurns(sql, "turn.cost", { ...window, cursor: first.cursor }, 3));
  assert.deepEqual(
    second.points.map(({ turnId }) => turnId),
    ["turn-3", "turn-9"],
  );
  assert.equal(second.finished, true);

  const session = value(readTurns(sql, "turn.cost", { ...window, sessionId: "session-2" }));
  assert.deepEqual(session.points, [
    {
      turnId: "turn-9",
      sessionId: "session-2",
      at: "2026-11-16T11:04:00+01:00",
      value: 5,
      dimensions: { harness: "Pi", model: "a" },
    },
  ]);
  const filtered = value(readTurns(sql, "turn.cost", { ...window, filter: ["harness:Codex"] }));
  assert.deepEqual(
    filtered.points.map(({ turnId }) => turnId),
    ["turn-2"],
  );

  const garbled = readTurns(sql, "turn.cost", { ...window, cursor: "not-a-cursor" });
  assert.ok(!garbled.ok);
  assert.equal(garbled.problem.code, "InvalidRequest");
});
