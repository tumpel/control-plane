import {
  MetricPathSchema,
  MetricSeriesQuerySchema,
  MetricTurnQuerySchema,
  MetricWindowSchema,
  TenantMetricCatalogSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import type { Outcome } from "./hosts";
import { issues, json, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import { tenantApi } from "./tenant-api.ts";

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const METRICS_PATH = "/v1/metrics";
const METRIC_PATH = /^\/v1\/metrics\/([^/]+)\/(series|turns)$/;
const REPEATED = ["filter", "groupBy"];

const queryOf = (url: URL): Record<string, unknown> => {
  const query: Record<string, unknown> = {};
  for (const [name, value] of url.searchParams) {
    if (!REPEATED.includes(name)) query[name] = value;
  }
  for (const name of REPEATED) {
    const values = url.searchParams.getAll(name);
    if (values.length > 0) query[name] = values;
  }
  return query;
};

const parsed = <T>(url: URL, schema: z.ZodType<T>, operation: string): Outcome<T> => {
  const query = schema.safeParse(queryOf(url));
  if (query.success) return { ok: true, value: query.data };
  return {
    ok: false,
    status: 400,
    problem: {
      code: "InvalidRequest",
      title: "Invalid query",
      detail: `${operation} refused the query: ${issues(query.error)}`,
      fix: "Send from and to as ISO 8601 times with an offset, and the other query parameters the operation's schema in typespec names",
    },
  };
};

const answer = <T>(outcome: Outcome<T>): Response =>
  outcome.ok ? json(outcome.value) : problem(outcome.status, outcome.problem);

const metricOf = (raw: string): Outcome<string> => {
  const metric = decodeURIComponent(raw);
  const path = MetricPathSchema.safeParse({ metric });
  if (path.success) return { ok: true, value: path.data.metric };
  return {
    ok: false,
    status: 404,
    problem: {
      code: "MetricNotFound",
      title: "No such metric",
      detail: `${metric} is not a metric name: ${issues(path.error)}`,
      fix: "List the metrics with the metrics catalog and query one of their names",
    },
  };
};

export const handleMetrics = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  if (request.method !== "GET") return null;
  const metricPath = METRIC_PATH.exec(url.pathname);
  if (url.pathname !== METRICS_PATH && metricPath === null) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  const store = env.TENANT_METRICS.getByName(caller.tenantId);
  if (metricPath === null) {
    const query = parsed(url, MetricWindowSchema, "metrics.catalog");
    if (!query.ok) return answer(query);
    const catalog = await store.catalog(query.value);
    if (!catalog.ok) return answer(catalog);
    const { usage } = await tenantApi(env.TENANT, caller.tenantId).call("readUsage", { tenantId: caller.tenantId });
    return json(TenantMetricCatalogSchema.parse({ ...catalog.value, usage }));
  }
  const metric = metricOf(metricPath[1] ?? "");
  if (!metric.ok) return answer(metric);
  if (metricPath[2] === "series") {
    const query = parsed(url, MetricSeriesQuerySchema, "metrics.query");
    if (!query.ok) return answer(query);
    return answer(await store.query(metric.value, query.value));
  }
  const query = parsed(url, MetricTurnQuerySchema, "metrics.turns");
  if (!query.ok) return answer(query);
  return answer(await store.turns(metric.value, query.value));
};
