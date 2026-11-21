import { DurableObject } from "cloudflare:workers";
import { MetricBatchSchema } from "@tumpel/schemas";
import metrics0001 from "../migrations/metrics/0001_metrics.sql";
import metrics0002 from "../migrations/metrics/0002_metrics_in_analytics_engine.sql";
import { migrateDurableObject } from "./durable-migrate";
import type { Outcome } from "./hosts";
import type { Env } from "./index";
import { queryAnalytics } from "./metrics-analytics.ts";
import {
  type AnalyticsTable,
  instrumentOf,
  instrumentOrRefusal,
  instrumentsOf,
  type MetricCatalog,
  type MetricSeriesQuery,
  type MetricSeriesSet,
  type MetricTurnPage,
  type MetricTurnQuery,
  type MetricWindow,
  planCatalog,
  planSeriesQuery,
  planTurnQuery,
  readCatalog,
  seriesSet,
  turnPage,
} from "./metrics-query.ts";
import { checkKinds, dataPointsOf, declareInstruments, METRICS_LIMITS, pointCount } from "./metrics-store.ts";

const METRICS_MIGRATIONS = [
  { name: "0001_metrics", sql: metrics0001 },
  { name: "0002_metrics_in_analytics_engine", sql: metrics0002 },
];

export class TenantMetrics extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      await migrateDurableObject(ctx.storage, METRICS_MIGRATIONS);
    });
  }

  record(batch: unknown): void {
    const parsed = MetricBatchSchema.safeParse(batch);
    if (!parsed.success) {
      throw new Error(
        `the metric batch does not match MetricBatch in typespec: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "batch"}: ${issue.message}`).join("; ")}; fix the points its sender built`,
      );
    }
    if (pointCount(parsed.data) > METRICS_LIMITS.pointsPerRecord) {
      throw new Error(
        `the metric batch holds ${pointCount(parsed.data)} points, more than the ${METRICS_LIMITS.pointsPerRecord} one call may write; split it with metricBatches`,
      );
    }
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      declareInstruments(sql, parsed.data.instruments, Date.now());
      checkKinds(sql, parsed.data);
    });
    for (const point of dataPointsOf(this.table().tenantId, parsed.data, METRICS_LIMITS)) {
      this.env.METRICS.writeDataPoint(point);
    }
  }

  async catalog(query: MetricWindow): Promise<Outcome<MetricCatalog>> {
    const planned = planCatalog(this.table(), query, METRICS_LIMITS);
    if (!planned.ok) return planned;
    const rows = await queryAnalytics(this.env, planned.value.sql);
    return readCatalog(instrumentsOf(this.ctx.storage.sql), rows, query, METRICS_LIMITS);
  }

  async query(metric: string, query: MetricSeriesQuery): Promise<Outcome<MetricSeriesSet>> {
    const instrument = instrumentOrRefusal(metric, instrumentOf(this.ctx.storage.sql, metric));
    if (!instrument.ok) return instrument;
    const planned = planSeriesQuery(this.table(), metric, query, Date.now(), METRICS_LIMITS);
    if (!planned.ok) return planned;
    const rows = await queryAnalytics(this.env, planned.value.sql);
    return seriesSet(instrument.value, query, planned.value, rows, METRICS_LIMITS);
  }

  async turns(metric: string, query: MetricTurnQuery): Promise<Outcome<MetricTurnPage>> {
    const instrument = instrumentOrRefusal(metric, instrumentOf(this.ctx.storage.sql, metric));
    if (!instrument.ok) return instrument;
    const planned = planTurnQuery(this.table(), metric, query);
    if (!planned.ok) return planned;
    const rows = await queryAnalytics(this.env, planned.value.sql);
    return { ok: true, value: turnPage(rows, query, planned.value) };
  }

  private table(): AnalyticsTable {
    const tenantId = this.ctx.id.name;
    if (tenantId === undefined) throw new Error("the metrics store was reached by id, not by its tenant name");
    return { dataset: this.env.METRICS_DATASET, tenantId };
  }
}
