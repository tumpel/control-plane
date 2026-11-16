import { DurableObject } from "cloudflare:workers";
import { MetricBatchSchema } from "@tumpel/schemas";
import metrics0001 from "../migrations/metrics/0001_metrics.sql";
import { migrateDurableObject } from "./durable-migrate";
import type { Env } from "./index";
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
}
