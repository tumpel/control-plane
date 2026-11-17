import type {
  MetricBucketSchema,
  MetricCatalogSchema,
  MetricSeriesQuerySchema,
  MetricSeriesSetSchema,
  MetricTurnPageSchema,
  MetricTurnQuerySchema,
  MetricWindowSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import type { Problem, ProblemStatus } from "./http.ts";
import { type ExponentialHistogram, histogramQuantile, mergeHistograms, parseHistogram } from "./metrics-histogram.ts";
import type { MetricsLimits, MetricsSql, SqlValue } from "./metrics-store.ts";

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

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const BUCKET_MS: Record<MetricBucket, number> = { Minute: MINUTE_MS, Hour: HOUR_MS, Day: DAY_MS };

const refuse = (status: ProblemStatus, problem: Refused["problem"]): Refused => ({ ok: false, status, problem });

const invalid = (detail: string, fix: string): Refused =>
  refuse(400, { code: "InvalidRequest", title: "Invalid metrics query", detail, fix });

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
    parsed.set(dimension, [...(parsed.get(dimension) ?? []), entry.slice(colon + 1)]);
  }
  return { ok: true, value: parsed };
};

interface Clause {
  sql: string;
  bindings: SqlValue[];
}

const filterClause = (filter: DimensionFilter): Clause => {
  const parts = [...filter].map(([dimension, values]) => ({
    sql: `s.series_id IN (SELECT series_id FROM series_dimension WHERE dimension = ? AND value IN (${values.map(() => "?").join(", ")}))`,
    bindings: [dimension, ...values],
  }));
  return {
    sql: parts.map((part) => ` AND ${part.sql}`).join(""),
    bindings: parts.flatMap((part) => part.bindings),
  };
};

const metricNotFound = (metric: string): Refused =>
  refuse(404, {
    code: "MetricNotFound",
    title: "No such metric",
    detail: `your tenant's metrics store has no metric ${metric}`,
    fix: "List the metrics with the metrics catalog and query one of their names",
  });

interface Instrument {
  metric: string;
  unit: string;
  kind: "Turn" | "Sample";
  description: string;
}

const instrumentOf = (sql: MetricsSql, metric: string): Instrument | undefined =>
  sql
    .exec<{ metric: string; unit: string; kind: string; description: string }>(
      "SELECT metric, unit, kind, description FROM metric WHERE metric = ?",
      metric,
    )
    .toArray()
    .map((row) => ({ ...row, kind: row.kind === "Turn" ? ("Turn" as const) : ("Sample" as const) }))[0];

export const readCatalog = (sql: MetricsSql, query: MetricWindow): Outcome<MetricCatalog> => {
  const window = windowOf(query);
  if (!window.ok) return window;
  const filter = parseFilter(query.filter);
  if (!filter.ok) return filter;
  const clause = filterClause(filter.value);
  const seen = `FROM series s WHERE s.last_seen_at >= ? AND s.first_seen_at < ?${clause.sql}`;
  const bindings = [window.value.from, window.value.to, ...clause.bindings];
  const instruments = sql
    .exec<{ metric: string; unit: string; kind: string; description: string }>(
      `SELECT m.metric, m.unit, m.kind, m.description FROM metric m WHERE m.metric IN (SELECT s.metric ${seen}) ORDER BY m.metric`,
      ...bindings,
    )
    .toArray();
  const facetRows = sql
    .exec<{ metric: string; dimension: string; value: string; series_count: number }>(
      `SELECT s.metric, d.dimension, d.value, COUNT(*) AS series_count FROM series_dimension d JOIN series s ON s.series_id = d.series_id WHERE s.series_id IN (SELECT s.series_id ${seen}) GROUP BY s.metric, d.dimension, d.value ORDER BY s.metric, d.dimension, d.value`,
      ...bindings,
    )
    .toArray();
  const facets = new Map<string, Map<string, { value: string; seriesCount: number }[]>>();
  for (const row of facetRows) {
    const dimensions = facets.get(row.metric) ?? new Map();
    facets.set(row.metric, dimensions);
    dimensions.set(row.dimension, [
      ...(dimensions.get(row.dimension) ?? []),
      { value: row.value, seriesCount: row.series_count },
    ]);
  }
  return {
    ok: true,
    value: {
      metrics: instruments.map(({ metric, unit, kind, description }) => ({
        metric,
        unit,
        kind: kind === "Turn" ? "Turn" : "Sample",
        description,
        facets: [...(facets.get(metric) ?? new Map())].map(([dimension, values]) => ({ dimension, values })),
      })),
    },
  };
};

export interface BucketPlan {
  bucket: MetricBucket;
  resolution: "Minute" | "Hour";
  first: number;
  to: number;
  startOf: (at: number) => number;
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
  const startOf = startFor(bucket, offset);
  const first = startOf(from);
  const oldest = bucket === "Minute" ? Math.ceil((now - limits.minuteRetentionMs) / size) * size : first;
  const tooOld = first < oldest;
  const tooMany = Math.ceil((to - first) / size) > MAX_BUCKETS;
  if (tooOld || tooMany) {
    const fitFrom = Math.max(first, oldest);
    const fitTo = Math.min(Math.max(to, fitFrom + size), fitFrom + MAX_BUCKETS * size);
    return refuse(422, {
      code: "MetricRangeTooLarge",
      title: "Metric range too large",
      detail: tooOld
        ? `Minute buckets reach back 8 days, and the window starts at ${query.from}`
        : `the window from ${query.from} to ${query.to} holds more than ${MAX_BUCKETS} ${bucket} buckets`,
      fix: `Query from ${formatAt(fitFrom, offset)} to ${formatAt(fitTo, offset)}, or pick a larger bucket`,
    });
  }
  return { ok: true, value: { bucket, resolution: bucket === "Minute" ? "Minute" : "Hour", first, to, startOf } };
};

interface Accumulator {
  count: number;
  sum: number;
  min: number;
  max: number;
  histogram: ExponentialHistogram;
}

interface GroupRows {
  group: Record<string, string>;
  total: number;
  buckets: Map<number, Accumulator>;
}

type RollupRow = {
  dimensions: string;
  bucket_start: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  histogram: string;
};

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
          histogram: mergeHistograms(known.histogram, row.histogram),
        },
  );
};

const isDimensions = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

const dimensionsOf = (canonical: string): Record<string, string> => {
  const parsed: unknown = JSON.parse(canonical);
  if (isDimensions(parsed)) return parsed;
  throw new Error(`a stored series has dimensions ${canonical}, not an object of strings; its series row is corrupt`);
};

const groupOf = (dimensions: Record<string, string>, groupBy: readonly string[]): Record<string, string> =>
  Object.fromEntries(groupBy.flatMap((key) => (key in dimensions ? [[key, dimensions[key] ?? ""]] : [])));

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

export const querySeries = (
  sql: MetricsSql,
  metric: string,
  query: MetricSeriesQuery,
  now: number,
  limits: MetricsLimits,
): Outcome<MetricSeriesSet> => {
  const plan = planBuckets(query.bucket, query, now, limits);
  if (!plan.ok) return plan;
  const filter = parseFilter(query.filter);
  if (!filter.ok) return filter;
  const instrument = instrumentOf(sql, metric);
  if (instrument === undefined) return metricNotFound(metric);
  const groupBy = query.groupBy ?? [];
  const clause = filterClause(filter.value);
  const rows = sql
    .exec<RollupRow>(
      `SELECT s.dimensions, r.bucket_start, r.count, r.sum, r.min, r.max, r.histogram FROM series s JOIN rollup r ON r.resolution = ? AND r.series_id = s.series_id AND r.bucket_start >= ? AND r.bucket_start < ? WHERE s.metric = ?${clause.sql}`,
      plan.value.resolution,
      plan.value.first,
      plan.value.to,
      metric,
      ...clause.bindings,
    )
    .toArray();
  const groups = new Map<string, GroupRows>();
  for (const row of rows) {
    const group = groupOf(dimensionsOf(row.dimensions), groupBy);
    const key = JSON.stringify(group);
    const rowsOfGroup = groups.get(key) ?? { group, total: 0, buckets: new Map() };
    groups.set(key, rowsOfGroup);
    rowsOfGroup.total += row.count;
    added(rowsOfGroup.buckets, plan.value.startOf(row.bucket_start), {
      count: row.count,
      sum: row.sum,
      min: row.min,
      max: row.max,
      histogram: parseHistogram(row.histogram),
    });
  }
  const offset = offsetOf(query.from);
  return {
    ok: true,
    value: {
      metric,
      unit: instrument.unit,
      bucket: query.bucket,
      series: folded([...groups.values()], groupBy).map(({ group, buckets }) => ({
        group,
        points: [...buckets]
          .sort(([left], [right]) => left - right)
          .map(([bucketStart, { count, sum, min, max, histogram }]) => ({
            bucketStart: formatAt(bucketStart, offset),
            count,
            sum,
            min,
            max,
            p50: histogramQuantile(histogram, 0.5, { min, max }),
            p90: histogramQuantile(histogram, 0.9, { min, max }),
            p99: histogramQuantile(histogram, 0.99, { min, max }),
          })),
      })),
    },
  };
};

interface TurnCursor {
  at: number;
  seriesId: number;
  turnId: string;
}

const encodeCursor = ({ at, seriesId, turnId }: TurnCursor): string =>
  btoa(JSON.stringify([at, seriesId, turnId]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const isCursorTuple = (value: unknown): value is [number, number, string] =>
  Array.isArray(value) &&
  value.length === 3 &&
  Number.isInteger(value[0]) &&
  Number.isInteger(value[1]) &&
  typeof value[2] === "string";

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
  const [at, seriesId, turnId] = decoded;
  return { at, seriesId, turnId };
};

export const readTurns = (
  sql: MetricsSql,
  metric: string,
  query: MetricTurnQuery,
  pageSize: number = TURN_PAGE_SIZE,
): Outcome<MetricTurnPage> => {
  const window = windowOf(query);
  if (!window.ok) return window;
  const filter = parseFilter(query.filter);
  if (!filter.ok) return filter;
  if (instrumentOf(sql, metric) === undefined) return metricNotFound(metric);
  const after = query.cursor === undefined || query.cursor === "" ? undefined : decodeCursor(query.cursor);
  if (query.cursor !== undefined && query.cursor !== "" && after === undefined) {
    return invalid(
      `the cursor ${JSON.stringify(query.cursor)} is not one a metrics turns page answered`,
      "Pass the cursor of the previous page, or leave it out to read from the start of the window",
    );
  }
  const clause = filterClause(filter.value);
  const session =
    query.sessionId === undefined
      ? { sql: "", bindings: [] }
      : { sql: " AND t.session_id = ?", bindings: [query.sessionId] };
  const position =
    after === undefined
      ? { sql: "", bindings: [] }
      : { sql: " AND (t.at, t.series_id, t.turn_id) > (?, ?, ?)", bindings: [after.at, after.seriesId, after.turnId] };
  const rows = sql
    .exec<{ series_id: number; at: number; turn_id: string; session_id: string; value: number; dimensions: string }>(
      `SELECT t.series_id, t.at, t.turn_id, t.session_id, t.value, s.dimensions FROM turn_point t JOIN series s ON s.series_id = t.series_id WHERE s.metric = ? AND t.at >= ? AND t.at < ?${session.sql}${position.sql}${clause.sql} ORDER BY t.at, t.series_id, t.turn_id LIMIT ?`,
      metric,
      window.value.from,
      window.value.to,
      ...session.bindings,
      ...position.bindings,
      ...clause.bindings,
      pageSize + 1,
    )
    .toArray();
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  return {
    ok: true,
    value: {
      points: page.map((row) => ({
        turnId: row.turn_id,
        sessionId: row.session_id,
        at: formatAt(row.at, window.value.offset),
        value: row.value,
        dimensions: dimensionsOf(row.dimensions),
      })),
      cursor:
        last === undefined
          ? (query.cursor ?? "")
          : encodeCursor({ at: last.at, seriesId: last.series_id, turnId: last.turn_id }),
      finished: rows.length <= pageSize,
    },
  };
};
