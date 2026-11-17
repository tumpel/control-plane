import { DurableObject } from "cloudflare:workers";
import { MetricBatchSchema } from "@tumpel/schemas";
import metrics0001 from "../migrations/metrics/0001_metrics.sql";
import { migrateDurableObject } from "./durable-migrate";
import type { Outcome } from "./hosts";
import type { Env } from "./index";
import {
  type MetricCatalog,
  type MetricSeriesQuery,
  type MetricSeriesSet,
  type MetricTurnPage,
  type MetricTurnQuery,
  type MetricWindow,
  querySeries,
  readCatalog,
  readTurns,
} from "./metrics-query.ts";
import { METRICS_LIMITS, recordBatch } from "./metrics-store.ts";

const METRICS_MIGRATIONS = [{ name: "0001_metrics", sql: metrics0001 }];

export class TenantMetrics extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateDurableObject(ctx.storage.sql, METRICS_MIGRATIONS);
    });
  }

  record(batch: unknown): void {
    const parsed = MetricBatchSchema.safeParse(batch);
    if (!parsed.success) {
      throw new Error(
        `the metric batch does not match MetricBatch in typespec: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "batch"}: ${issue.message}`).join("; ")}; fix the points its sender built`,
      );
    }
    this.ctx.storage.transactionSync(() => recordBatch(this.ctx.storage.sql, parsed.data, Date.now(), METRICS_LIMITS));
  }

  catalog(query: MetricWindow): Outcome<MetricCatalog> {
    return readCatalog(this.ctx.storage.sql, query);
  }

  query(metric: string, query: MetricSeriesQuery): Outcome<MetricSeriesSet> {
    return querySeries(this.ctx.storage.sql, metric, query, Date.now(), METRICS_LIMITS);
  }

  turns(metric: string, query: MetricTurnQuery): Outcome<MetricTurnPage> {
    return readTurns(this.ctx.storage.sql, metric, query);
  }
}
