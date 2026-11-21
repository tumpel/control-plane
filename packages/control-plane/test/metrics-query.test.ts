import assert from "node:assert/strict";
import { test } from "node:test";
import { binOf } from "../src/metrics-histogram.ts";
import {
  type AnalyticsTable,
  type Instrument,
  MAX_GROUPS,
  type MetricSeriesQuery,
  OTHER_GROUP,
  type Outcome,
  planBuckets,
  planCatalog,
  planSeriesQuery,
  planTurnQuery,
  readCatalog,
  seriesSet,
  turnPage,
} from "../src/metrics-query.ts";
import { METRICS_LIMITS } from "../src/metrics-store.ts";

const T0 = Date.parse("2026-11-16T10:00:00+00:00");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TABLE: AnalyticsTable = { dataset: "tumpel_metrics", tenantId: "tenant-1" };
const COST: Instrument = { metric: "turn.cost", unit: "uUSD", kind: "Turn", description: "What a turn cost" };

const iso = (at: number): string => new Date(at).toISOString();

const value = <T>(outcome: Outcome<T>): T => {
  assert.ok(outcome.ok, outcome.ok ? "" : `${outcome.problem.title}: ${outcome.problem.detail}`);
  return outcome.value;
};

const rowsOf = (points: readonly { bucket: number; value: number; groups?: string[] }[]) =>
  points.map(({ bucket, value: point, groups }) => ({
    bucket,
    ...Object.fromEntries((groups ?? []).map((slot, index) => [`g${index}`, slot])),
    side: binOf(point).side,
    bin: binOf(point).index,
    weight: "1",
    total: point,
    low: point,
    high: point,
  }));

test("a filter ORs the values of one dimension across every slot and ANDs different dimensions", () => {
  const { sql } = value(
    planSeriesQuery(
      TABLE,
      "turn.cost",
      { from: iso(T0), to: iso(T0 + HOUR), bucket: "Hour", filter: ["harness:Pi", "harness:Codex", "model:a"] },
      T0,
      METRICS_LIMITS,
    ),
  );
  const slots = Array.from({ length: 8 }, (_, slot) => `blob${5 + slot}`);
  assert.ok(sql.includes(`(${slots.map((blob) => `${blob} IN ('harness=Pi', 'harness=Codex')`).join(" OR ")})`));
  assert.ok(sql.includes(` AND (${slots.map((blob) => `${blob} IN ('model=a')`).join(" OR ")})`));
  assert.match(sql, /^SELECT .* WHERE index1 = 'tenant-1' AND blob1 = 'turn\.cost' AND /);
  assert.match(sql, / LIMIT 10001$/);
});

test("a filter, group or session holding a quote or space is refused before it reaches a query", () => {
  const window = { from: iso(T0), to: iso(T0 + HOUR) };
  const refusals = [
    planSeriesQuery(
      TABLE,
      "turn.cost",
      { ...window, bucket: "Hour", filter: ["harness:Pi' OR 1=1"] },
      T0,
      METRICS_LIMITS,
    ),
    planSeriesQuery(TABLE, "turn.cost", { ...window, bucket: "Hour", groupBy: ["har ness"] }, T0, METRICS_LIMITS),
    planTurnQuery(TABLE, "turn.cost", { ...window, sessionId: "s'1" }),
    planCatalog(TABLE, { ...window, filter: ["model:a b"] }, METRICS_LIMITS),
  ];
  for (const refused of refusals) {
    assert.ok(!refused.ok);
    assert.equal(refused.problem.code, "InvalidRequest");
  }
});

test("group-by keys each row by its slot value and folds groups past the cap into Other", () => {
  const query: MetricSeriesQuery = { from: iso(T0), to: iso(T0 + HOUR), bucket: "Hour", groupBy: ["model"] };
  const planned = value(planSeriesQuery(TABLE, "turn.cost", query, T0, METRICS_LIMITS));
  const rows = rowsOf([
    { bucket: 0, value: 10, groups: ["model=a"] },
    { bucket: 0, value: 30, groups: ["model=a"] },
    { bucket: 0, value: 20, groups: ["model=b"] },
    { bucket: 0, value: 5, groups: [""] },
    { bucket: 0, value: 5, groups: [""] },
    { bucket: 0, value: 5, groups: [""] },
    ...Array.from({ length: MAX_GROUPS + 2 }, (_, index) => ({
      bucket: 0,
      value: 1,
      groups: [`model=m${String(index).padStart(2, "0")}`],
    })),
  ]);

  const set = value(seriesSet(COST, query, planned, rows, METRICS_LIMITS));
  assert.equal(set.series.length, MAX_GROUPS + 1);
  assert.deepEqual(
    set.series.slice(0, 2).map(({ group, points }) => ({ group, count: points[0]?.count, sum: points[0]?.sum })),
    [
      { group: {}, count: 3, sum: 15 },
      { group: { model: "a" }, count: 2, sum: 40 },
    ],
  );
  assert.deepEqual(set.series.at(-1)?.group, { model: OTHER_GROUP });
  assert.equal(set.series.at(-1)?.points[0]?.count, 5);
});

test("Day buckets start at midnight in the offset of from", () => {
  const query: MetricSeriesQuery = {
    from: "2026-11-15T12:00:00+02:00",
    to: "2026-11-17T00:00:00+02:00",
    bucket: "Day",
  };
  const planned = value(planSeriesQuery(TABLE, "turn.cost", query, T0, METRICS_LIMITS));
  assert.equal(planned.plan.first, Date.parse("2026-11-15T00:00:00+02:00"));

  const days = value(
    seriesSet(
      COST,
      query,
      planned,
      rowsOf([
        { bucket: 0, value: 1 },
        { bucket: 1, value: 2 },
        { bucket: 1, value: 4 },
      ]),
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

test("percentiles of a bucket come from its rows' histogram bins within 5 % of the exact value", () => {
  const query: MetricSeriesQuery = { from: iso(T0), to: iso(T0 + HOUR), bucket: "Hour" };
  const planned = value(planSeriesQuery(TABLE, "turn.cost", query, T0, METRICS_LIMITS));
  const values = Array.from({ length: 1_000 }, (_, index) => 1.3 ** (index % 40) * (1 + (index % 7) / 7));

  const [point] =
    value(seriesSet(COST, query, planned, rowsOf(values.map((cost) => ({ bucket: 0, value: cost }))), METRICS_LIMITS))
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

test("a range past 500 buckets or past retention is refused with a range that fits", () => {
  const tooMany = planBuckets(
    "Minute",
    { from: "2026-11-16T10:00:00+01:00", to: "2026-11-17T10:00:00+01:00" },
    T0,
    METRICS_LIMITS,
  );
  assert.ok(!tooMany.ok);
  assert.equal(tooMany.problem.code, "MetricRangeTooLarge");
  assert.match(tooMany.problem.fix, /from 2026-11-16T10:00:00\+01:00 to 2026-11-16T18:20:00\+01:00/);

  const tooOld = planBuckets("Hour", { from: iso(T0 - 91 * DAY), to: iso(T0 - 91 * DAY + HOUR) }, T0, METRICS_LIMITS);
  assert.ok(!tooOld.ok);
  assert.match(tooOld.problem.fix, /from 2026-08-18T10:00:00Z to 2026-08-18T11:00:00Z/);

  assert.ok(planBuckets("Hour", { from: iso(T0 - 20 * DAY), to: iso(T0) }, T0, METRICS_LIMITS).ok);
  const backwards = planBuckets("Hour", { from: iso(T0), to: iso(T0) }, T0, METRICS_LIMITS);
  assert.ok(!backwards.ok);
  assert.equal(backwards.problem.code, "InvalidRequest");
});

test("the catalog lists declared metrics with each dimension's values and series counts, and refuses past its row cap", () => {
  const query = { from: iso(T0 - HOUR), to: iso(T0 + HOUR) };
  const catalog = value(
    readCatalog(
      [COST, { metric: "host.cpu.busy", unit: "1", kind: "Sample", description: "Busy share" }],
      [
        { metric: "turn.cost", dimensions: '{"harness":"Pi","model":"a"}' },
        { metric: "turn.cost", dimensions: '{"harness":"Pi","model":"b"}' },
        { metric: "turn.cost", dimensions: '{"harness":"Codex","model":"a"}' },
      ],
      query,
      METRICS_LIMITS,
    ),
  );
  assert.deepEqual(catalog.metrics, [
    {
      ...COST,
      facets: [
        {
          dimension: "harness",
          values: [
            { value: "Codex", seriesCount: 1 },
            { value: "Pi", seriesCount: 2 },
          ],
        },
        {
          dimension: "model",
          values: [
            { value: "a", seriesCount: 2 },
            { value: "b", seriesCount: 1 },
          ],
        },
      ],
    },
  ]);

  const crowded = readCatalog(
    [COST],
    Array.from({ length: METRICS_LIMITS.rowsPerQuery + 1 }, (_, index) => ({
      metric: "turn.cost",
      dimensions: `{"model":"m${index}"}`,
    })),
    query,
    METRICS_LIMITS,
  );
  assert.ok(!crowded.ok);
  assert.equal(crowded.problem.code, "MetricRangeTooLarge");
});

test("turns page in order and the next page's query starts after the cursor", () => {
  const window = { from: "2026-11-16T11:00:00+01:00", to: iso(T0 + HOUR) };
  const first = value(planTurnQuery(TABLE, "turn.cost", window, 2));
  const rows = [0, 1, 2].map((index) => ({
    at: T0 + index * 60_000,
    turnId: `turn-${index}`,
    sessionId: "session-1",
    value: index,
    dimensions: '{"harness":"Pi"}',
  }));

  const page = turnPage(rows, window, first);
  assert.deepEqual(
    page.points.map(({ turnId, at }) => [turnId, at]),
    [
      ["turn-0", "2026-11-16T11:00:00+01:00"],
      ["turn-1", "2026-11-16T11:01:00+01:00"],
    ],
  );
  assert.equal(page.finished, false);
  assert.deepEqual(page.points[0]?.dimensions, { harness: "Pi" });

  const next = value(planTurnQuery(TABLE, "turn.cost", { ...window, cursor: page.cursor, sessionId: "session-1" }, 2));
  assert.ok(next.sql.includes(`(double2 > ${T0 + 60_000} OR (double2 = ${T0 + 60_000} AND blob3 > 'turn-1'))`));
  assert.ok(next.sql.includes("blob4 = 'session-1'"));
  assert.ok(next.sql.endsWith("ORDER BY at, turnId LIMIT 3"));

  const garbled = planTurnQuery(TABLE, "turn.cost", { ...window, cursor: "not-a-cursor" });
  assert.ok(!garbled.ok);
  assert.equal(garbled.problem.code, "InvalidRequest");
});
