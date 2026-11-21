import type {
  MetricBucketSchema,
  MetricCatalogSchema,
  MetricSeriesQuerySchema,
  MetricSeriesSetSchema,
  MetricTurnPageSchema,
  MetricTurnQuerySchema,
  MetricWindowSchema,
} from "@tumpel/schemas";
import { z } from "zod";
import type { Problem, ProblemStatus } from "./http.ts";
import { type HistogramBin, histogramOfBins, histogramQuantile } from "./metrics-histogram.ts";
import { DIMENSION_SLOTS, FIRST_SLOT_BLOB, type MetricsLimits, type MetricsSql } from "./metrics-store.ts";

export type MetricWindow = z.infer<typeof MetricWindowSchema>;
export type MetricSeriesQuery = z.infer<typeof MetricSeriesQuerySchema>;
export type MetricTurnQuery = z.infer<typeof MetricTurnQuerySchema>;
export type MetricBucket = z.infer<typeof MetricBucketSchema>;
export type MetricCatalog = z.infer<typeof MetricCatalogSchema>;
export type MetricSeriesSet = z.infer<typeof MetricSeriesSetSchema>;
export type MetricTurnPage = z.infer<typeof MetricTurnPageSchema>;

export type Refused = { ok: false; status: ProblemStatus; problem: Problem };
export type Outcome<T> = { ok: true; value: T } | Refused;

export const MAX_BUCKETS = 500;
export const MAX_GROUPS = 20;
export const TURN_PAGE_SIZE = 200;
export const OTHER_GROUP = "Other";
export const WRITE_SKEW_MS = 10 * 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const BUCKET_MS: Record<MetricBucket, number> = { Minute: MINUTE_MS, Hour: HOUR_MS, Day: DAY_MS };
const SAFE_TEXT = /^[A-Za-z0-9._:@/+-]{1,128}$/;

const refuse = (status: ProblemStatus, problem: Refused["problem"]): Refused => ({ ok: false, status, problem });

const invalid = (detail: string, fix: string): Refused =>
  refuse(400, { code: "InvalidRequest", title: "Invalid metrics query", detail, fix });

const unsafe = (what: string, text: string): Refused =>
  invalid(
    `the ${what} ${JSON.stringify(text)} holds characters a metrics query cannot match`,
    "Use only letters, digits and . _ : @ / + - in metrics filters, groups and session ids",
  );

const quoted = (text: string): string => {
  if (!SAFE_TEXT.test(text.replaceAll("=", ""))) {
    throw new Error(`${JSON.stringify(text)} reached a metrics query unchecked; refuse it where the query is parsed`);
  }
  return `'${text}'`;
};

interface Offset {
  text: string;
  ms: number;
}

const offsetOf = (at: string): Offset => {
  const zoned = /([+-])(\d{2}):?(\d{2})$/.exec(at);
  if (zoned === null) return { text: "Z", ms: 0 };
  const [, sign, hours, minutes] = zoned;
  const ms = (Number(hours) * 60 + Number(minutes)) * MINUTE_MS * (sign === "-" ? -1 : 1);
  return { text: `${sign}${hours}:${minutes}`, ms };
};

export const formatAt = (ms: number, offset: Offset): string =>
  `${new Date(ms + offset.ms).toISOString().slice(0, ms % 1000 === 0 ? 19 : 23)}${offset.text}`;

interface Window {
  from: number;
  to: number;
  offset: Offset;
}

const windowOf = (query: MetricWindow): Outcome<Window> => {
  const from = Date.parse(query.from);
  const to = Date.parse(query.to);
  if (to <= from) {
    return invalid(`the window ends at ${query.to}, not after its start ${query.from}`, "Send a to after from");
  }
  return { ok: true, value: { from, to, offset: offsetOf(query.from) } };
};

export type DimensionFilter = Map<string, string[]>;

export const parseFilter = (filter: readonly string[] | undefined): Outcome<DimensionFilter> => {
  const parsed: DimensionFilter = new Map();
  for (const entry of filter ?? []) {
    const colon = entry.indexOf(":");
    if (colon < 1) {
      return invalid(
        `the filter ${JSON.stringify(entry)} names no dimension`,
        "Write each filter as dimension:value, such as harness:Pi",
      );
    }
    const dimension = entry.slice(0, colon);
    const value = entry.slice(colon + 1);
    if (!SAFE_TEXT.test(dimension)) return unsafe("filter dimension", dimension);
    if (!SAFE_TEXT.test(value)) return unsafe("filter value", value);
    parsed.set(dimension, [...(parsed.get(dimension) ?? []), value]);
  }
  return { ok: true, value: parsed };
};

const isDimensions = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

const dimensionsOf = (canonical: string): Record<string, string> => {
  const parsed: unknown = JSON.parse(canonical);
  if (isDimensions(parsed)) return parsed;
  throw new Error(`a metric point has dimensions ${canonical}, not an object of strings; its writer is broken`);
};

const metricNotFound = (metric: string): Refused =>
  refuse(404, {
    code: "MetricNotFound",
    title: "No such metric",
    detail: `your tenant's metrics store has no metric ${metric}`,
    fix: "List the metrics with the metrics catalog and query one of their names",
  });

export interface Instrument {
  metric: string;
  unit: string;
  kind: "Turn" | "Sample";
  description: string;
}

export const instrumentOrRefusal = (metric: string, instrument: Instrument | undefined): Outcome<Instrument> =>
  instrument === undefined || !SAFE_TEXT.test(metric) ? metricNotFound(metric) : { ok: true, value: instrument };

const tooManyRows = (query: MetricWindow, rows: number, what: string): Refused =>
  refuse(422, {
    code: "MetricRangeTooLarge",
    title: "Metric range too large",
    detail: `the window from ${query.from} to ${query.to} holds more than ${rows} rows of ${what}`,
    fix: "Query a shorter window, pick a larger bucket, or filter to fewer series",
  });

export interface AnalyticsTable {
  dataset: string;
  tenantId: string;
}

const slotBlobs = Array.from({ length: DIMENSION_SLOTS }, (_, slot) => `blob${FIRST_SLOT_BLOB + slot}`);

const whereOf = (
  table: AnalyticsTable,
  metric: string | undefined,
  from: number,
  to: number,
  filter: DimensionFilter,
): string =>
  [
    `index1 = ${quoted(table.tenantId)}`,
    ...(metric === undefined ? [] : [`blob1 = ${quoted(metric)}`]),
    `timestamp >= toDateTime(${Math.floor((from - WRITE_SKEW_MS) / 1000)})`,
    `double2 >= ${from}`,
    `double2 < ${to}`,
    ...[...filter].map(([dimension, values]) => {
      const wanted = values.map((value) => quoted(`${dimension}=${value}`)).join(", ");
      return `(${slotBlobs.map((blob) => `${blob} IN (${wanted})`).join(" OR ")})`;
    }),
  ].join(" AND ");

const groupExpression = (dimension: string): string =>
  slotBlobs.reduceRight(
    (otherwise, blob) => `if(startsWith(${blob}, ${quoted(`${dimension}=`)}), ${blob}, ${otherwise})`,
    "''",
  );

const sqlName = (dataset: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dataset)) {
    throw new Error(`METRICS_DATASET ${JSON.stringify(dataset)} is not a dataset name; fix it in wrangler.jsonc`);
  }
  return dataset;
};

export interface CatalogPlan {
  window: Window;
  filter: DimensionFilter;
  sql: string;
}

export const planCatalog = (
  table: AnalyticsTable,
  query: MetricWindow,
  limits: MetricsLimits,
): Outcome<CatalogPlan> => {
  const window = windowOf(query);
  if (!window.ok) return window;
  const filter = parseFilter(query.filter);
  if (!filter.ok) return filter;
  const { from, to } = window.value;
  const sql = `SELECT blob1 AS metric, blob2 AS dimensions FROM ${sqlName(table.dataset)} WHERE ${whereOf(table, undefined, from, to, filter.value)} GROUP BY metric, dimensions ORDER BY metric, dimensions LIMIT ${limits.rowsPerQuery + 1}`;
  return { ok: true, value: { window: window.value, filter: filter.value, sql } };
};

const CatalogRowSchema = z.object({ metric: z.string(), dimensions: z.string() });

export const readCatalog = (
  instruments: readonly Instrument[],
  rows: readonly unknown[],
  query: MetricWindow,
  limits: MetricsLimits,
): Outcome<MetricCatalog> => {
  if (rows.length > limits.rowsPerQuery) return tooManyRows(query, limits.rowsPerQuery, "metric series");
  const facets = new Map<string, Map<string, Map<string, number>>>();
  for (const row of rows) {
    const { metric, dimensions: canonical } = CatalogRowSchema.parse(row);
    const dimensions = facets.get(metric) ?? new Map<string, Map<string, number>>();
    facets.set(metric, dimensions);
    for (const [dimension, value] of Object.entries(dimensionsOf(canonical))) {
      const values = dimensions.get(dimension) ?? new Map<string, number>();
      dimensions.set(dimension, values);
      values.set(value, (values.get(value) ?? 0) + 1);
    }
  }
  const sorted = <T>(entries: Iterable<[string, T]>): [string, T][] =>
    [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    ok: true,
    value: {
      metrics: instruments
        .filter(({ metric }) => facets.has(metric))
        .sort((left, right) => (left.metric < right.metric ? -1 : left.metric > right.metric ? 1 : 0))
        .map(({ metric, unit, kind, description }) => ({
          metric,
          unit,
          kind,
          description,
          facets: sorted(facets.get(metric) ?? new Map<string, Map<string, number>>()).map(([dimension, values]) => ({
            dimension,
            values: sorted(values).map(([value, seriesCount]) => ({ value, seriesCount })),
          })),
        })),
    },
  };
};

export interface BucketPlan {
  bucket: MetricBucket;
  size: number;
  first: number;
  to: number;
}

const startFor = (bucket: MetricBucket, offset: Offset): ((at: number) => number) => {
  const size = BUCKET_MS[bucket];
  if (bucket === "Day") return (at) => Math.floor((at + offset.ms) / size) * size - offset.ms;
  return (at) => Math.floor(at / size) * size;
};

export const planBuckets = (
  bucket: MetricBucket,
  query: MetricWindow,
  now: number,
  limits: MetricsLimits,
): Outcome<BucketPlan> => {
  const window = windowOf(query);
  if (!window.ok) return window;
  const { from, to, offset } = window.value;
  const size = BUCKET_MS[bucket];
  const first = startFor(bucket, offset)(from);
  const oldest = Math.ceil((now - limits.retentionMs) / size) * size;
  const tooOld = first < oldest;
  const tooMany = Math.ceil((to - first) / size) > MAX_BUCKETS;
  if (tooOld || tooMany) {
    const fitFrom = Math.max(first, oldest);
    const fitTo = Math.min(Math.max(to, fitFrom + size), fitFrom + MAX_BUCKETS * size);
    return refuse(422, {
      code: "MetricRangeTooLarge",
      title: "Metric range too large",
      detail: tooOld
        ? `metrics reach back ${limits.retentionMs / DAY_MS} days, and the window starts at ${query.from}`
        : `the window from ${query.from} to ${query.to} holds more than ${MAX_BUCKETS} ${bucket} buckets`,
      fix: `Query from ${formatAt(fitFrom, offset)} to ${formatAt(fitTo, offset)}, or pick a larger bucket`,
    });
  }
  return { ok: true, value: { bucket, size, first, to } };
};

export interface SeriesQueryPlan {
  plan: BucketPlan;
  groupBy: string[];
  sql: string;
}

export const planSeriesQuery = (
  table: AnalyticsTable,
  metric: string,
  query: MetricSeriesQuery,
  now: number,
  limits: MetricsLimits,
): Outcome<SeriesQueryPlan> => {
  const plan = planBuckets(query.bucket, query, now, limits);
  if (!plan.ok) return plan;
  const filter = parseFilter(query.filter);
  if (!filter.ok) return filter;
  const groupBy = query.groupBy ?? [];
  const badGroup = groupBy.find((dimension) => !SAFE_TEXT.test(dimension));
  if (badGroup !== undefined) return unsafe("group-by dimension", badGroup);
  const { first, size, to } = plan.value;
  const keys = ["bucket", ...groupBy.map((_, index) => `g${index}`), "side", "bin"].join(", ");
  const columns = [
    `floor((double2 - ${first}) / ${size}) AS bucket`,
    ...groupBy.map((dimension, index) => `${groupExpression(dimension)} AS g${index}`),
    "double3 AS side",
    "double4 AS bin",
    "sum(_sample_interval) AS weight",
    "sum(double1 * _sample_interval) AS total",
    "min(double1) AS low",
    "max(double1) AS high",
  ].join(", ");
  const sql = `SELECT ${columns} FROM ${sqlName(table.dataset)} WHERE ${whereOf(table, metric, first, to, filter.value)} GROUP BY ${keys} ORDER BY ${keys} LIMIT ${limits.rowsPerQuery + 1}`;
  return { ok: true, value: { plan: plan.value, groupBy, sql } };
};

const SeriesRowSchema = z
  .object({
    bucket: z.coerce.number(),
    side: z.coerce.number(),
    bin: z.coerce.number(),
    weight: z.coerce.number(),
    total: z.coerce.number(),
    low: z.coerce.number(),
    high: z.coerce.number(),
  })
  .catchall(z.unknown());

interface Accumulator {
  count: number;
  sum: number;
  min: number;
  max: number;
  bins: HistogramBin[];
}

interface GroupRows {
  group: Record<string, string>;
  total: number;
  buckets: Map<number, Accumulator>;
}

const added = (into: Map<number, Accumulator>, bucketStart: number, row: Accumulator): void => {
  const known = into.get(bucketStart);
  into.set(
    bucketStart,
    known === undefined
      ? row
      : {
          count: known.count + row.count,
          sum: known.sum + row.sum,
          min: Math.min(known.min, row.min),
          max: Math.max(known.max, row.max),
          bins: [...known.bins, ...row.bins],
        },
  );
};

const folded = (groups: GroupRows[], groupBy: readonly string[]): GroupRows[] => {
  const ranked = [...groups].sort(
    (left, right) => right.total - left.total || JSON.stringify(left.group).localeCompare(JSON.stringify(right.group)),
  );
  if (ranked.length <= MAX_GROUPS) return ranked;
  const kept = ranked.slice(0, MAX_GROUPS);
  const other: GroupRows = {
    group: Object.fromEntries(groupBy.map((key) => [key, OTHER_GROUP])),
    total: 0,
    buckets: new Map(),
  };
  for (const rest of ranked.slice(MAX_GROUPS)) {
    other.total += rest.total;
    for (const [bucketStart, accumulator] of rest.buckets) added(other.buckets, bucketStart, accumulator);
  }
  return [...kept, other];
};

const groupOfRow = (row: Record<string, unknown>, groupBy: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    groupBy.flatMap((dimension, index) => {
      const slot = row[`g${index}`];
      if (typeof slot !== "string" || slot === "") return [];
      return [[dimension, slot.slice(dimension.length + 1)]];
    }),
  );

export const seriesSet = (
  instrument: Instrument,
  query: MetricSeriesQuery,
  { plan, groupBy }: SeriesQueryPlan,
  rows: readonly unknown[],
  limits: MetricsLimits,
): Outcome<MetricSeriesSet> => {
  if (rows.length > limits.rowsPerQuery) return tooManyRows(query, limits.rowsPerQuery, instrument.metric);
  const groups = new Map<string, GroupRows>();
  for (const raw of rows) {
    const row = SeriesRowSchema.parse(raw);
    const group = groupOfRow(row, groupBy);
    const key = JSON.stringify(group);
    const rowsOfGroup = groups.get(key) ?? { group, total: 0, buckets: new Map() };
    groups.set(key, rowsOfGroup);
    rowsOfGroup.total += row.weight;
    added(rowsOfGroup.buckets, plan.first + row.bucket * plan.size, {
      count: row.weight,
      sum: row.total,
      min: row.low,
      max: row.high,
      bins: [{ side: row.side, index: row.bin, count: row.weight }],
    });
  }
  const offset = offsetOf(query.from);
  return {
    ok: true,
    value: {
      metric: instrument.metric,
      unit: instrument.unit,
      bucket: query.bucket,
      series: folded([...groups.values()], groupBy).map(({ group, buckets }) => ({
        group,
        points: [...buckets]
          .sort(([left], [right]) => left - right)
          .map(([bucketStart, { count, sum, min, max, bins }]) => {
            const histogram = histogramOfBins(bins);
            return {
              bucketStart: formatAt(bucketStart, offset),
              count,
              sum,
              min,
              max,
              p50: histogramQuantile(histogram, 0.5, { min, max }),
              p90: histogramQuantile(histogram, 0.9, { min, max }),
              p99: histogramQuantile(histogram, 0.99, { min, max }),
            };
          }),
      })),
    },
  };
};

interface TurnCursor {
  at: number;
  turnId: string;
}

const encodeCursor = ({ at, turnId }: TurnCursor): string =>
  btoa(JSON.stringify([at, turnId]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const isCursorTuple = (value: unknown): value is [number, string] =>
  Array.isArray(value) &&
  value.length === 2 &&
  Number.isInteger(value[0]) &&
  typeof value[1] === "string" &&
  SAFE_TEXT.test(value[1]);

const cursorJson = (cursor: string): unknown => {
  try {
    return JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
  } catch {
    return undefined;
  }
};

export const decodeCursor = (cursor: string): TurnCursor | undefined => {
  const decoded = cursorJson(cursor);
  if (!isCursorTuple(decoded)) return undefined;
  const [at, turnId] = decoded;
  return { at, turnId };
};

export interface TurnQueryPlan {
  offset: Offset;
  sql: string;
  pageSize: number;
}

export const planTurnQuery = (
  table: AnalyticsTable,
  metric: string,
  query: MetricTurnQuery,
  pageSize: number = TURN_PAGE_SIZE,
): Outcome<TurnQueryPlan> => {
  const window = windowOf(query);
  if (!window.ok) return window;
  const filter = parseFilter(query.filter);
  if (!filter.ok) return filter;
  if (query.sessionId !== undefined && !SAFE_TEXT.test(query.sessionId)) return unsafe("session id", query.sessionId);
  const after = query.cursor === undefined || query.cursor === "" ? undefined : decodeCursor(query.cursor);
  if (query.cursor !== undefined && query.cursor !== "" && after === undefined) {
    return invalid(
      `the cursor ${JSON.stringify(query.cursor)} is not one a metrics turns page answered`,
      "Pass the cursor of the previous page, or leave it out to read from the start of the window",
    );
  }
  const { from, to, offset } = window.value;
  const conditions = [
    whereOf(table, metric, from, to, filter.value),
    "blob3 != ''",
    ...(query.sessionId === undefined ? [] : [`blob4 = ${quoted(query.sessionId)}`]),
    ...(after === undefined
      ? []
      : [`(double2 > ${after.at} OR (double2 = ${after.at} AND blob3 > ${quoted(after.turnId)}))`]),
  ];
  const sql = `SELECT double2 AS at, blob3 AS turnId, blob4 AS sessionId, double1 AS value, blob2 AS dimensions FROM ${sqlName(table.dataset)} WHERE ${conditions.join(" AND ")} ORDER BY at, turnId LIMIT ${pageSize + 1}`;
  return { ok: true, value: { offset, sql, pageSize } };
};

const TurnRowSchema = z.object({
  at: z.coerce.number(),
  turnId: z.string(),
  sessionId: z.string(),
  value: z.coerce.number(),
  dimensions: z.string(),
});

export const turnPage = (rows: readonly unknown[], query: MetricTurnQuery, plan: TurnQueryPlan): MetricTurnPage => {
  const page = rows.slice(0, plan.pageSize).map((row) => TurnRowSchema.parse(row));
  const last = page.at(-1);
  return {
    points: page.map((turn) => ({
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      at: formatAt(turn.at, plan.offset),
      value: turn.value,
      dimensions: dimensionsOf(turn.dimensions),
    })),
    cursor: last === undefined ? (query.cursor ?? "") : encodeCursor({ at: last.at, turnId: last.turnId }),
    finished: rows.length <= plan.pageSize,
  };
};

type InstrumentRow = { metric: string; unit: string; kind: string; description: string };

const instrumentOfRow = (row: InstrumentRow): Instrument => ({
  ...row,
  kind: row.kind === "Turn" ? "Turn" : "Sample",
});

export const instrumentOf = (sql: MetricsSql, metric: string): Instrument | undefined =>
  sql
    .exec<InstrumentRow>("SELECT metric, unit, kind, description FROM metric WHERE metric = ?", metric)
    .toArray()
    .map(instrumentOfRow)[0];

export const instrumentsOf = (sql: MetricsSql): Instrument[] =>
  sql.exec<InstrumentRow>("SELECT metric, unit, kind, description FROM metric").toArray().map(instrumentOfRow);
