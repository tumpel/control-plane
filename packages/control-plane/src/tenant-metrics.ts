import { DurableObject } from "cloudflare:workers";
import { MetricBatchSchema } from "@tumpel/schemas";
import metrics0001 from "../migrations/metrics/0001_metrics.sql";
import metrics0002 from "../migrations/metrics/0002_metric_windows.sql";
import { backoffMs, errorOf, RETRY_LIMIT } from "./backoff.ts";
import { sha256Hex } from "./crypto.ts";
import { migrateDurableObject } from "./durable-migrate";
import type { Outcome } from "./hosts";
import type { Env } from "./index";
import {
  filteredSeries,
  instrumentOf,
  instrumentOrRefusal,
  instrumentsOf,
  type MetricCatalog,
  type MetricSeriesQuery,
  type MetricSeriesSet,
  type MetricTurnPage,
  type MetricTurnQuery,
  type MetricWindow,
  planSeriesQuery,
  planTurnQuery,
  readCatalog,
  seriesSet,
  TURN_PAGE_SIZE,
  turnPage,
  turnsOfWindow,
} from "./metrics-query.ts";
import {
  bufferBatch,
  type Catalog,
  checkKinds,
  declareInstruments,
  EMPTY_CATALOG,
  EMPTY_WINDOW,
  METRICS_LIMITS,
  mergeUpdates,
  mergeWindow,
  type Pending,
  parseCatalog,
  parseWindow,
  type Resolution,
  resolvePending,
  type StoredTurn,
  WINDOW_MS,
  type WindowDoc,
  type WindowUpdate,
  windowRetentionMs,
} from "./metrics-store.ts";

const METRICS_MIGRATIONS = [
  { name: "0001_metrics", sql: metrics0001 },
  { name: "0002_metric_windows", sql: metrics0002 },
];

export const METRICS_FLUSH_MS = 60_000;
const FLUSH_FIRST_RETRY_MS = 5_000;

export class TenantMetrics extends DurableObject<Env> {
  private pending: Pending = new Map();
  private unwritten: WindowUpdate[] = [];
  private catalogUnwritten = false;
  private loadedCatalog: Catalog | undefined;
  private retries = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      await migrateDurableObject(ctx.storage, METRICS_MIGRATIONS);
    });
  }

  async record(batch: unknown): Promise<void> {
    const parsed = MetricBatchSchema.safeParse(batch);
    if (!parsed.success) {
      throw new Error(
        `the metric batch does not match MetricBatch in typespec: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "batch"}: ${issue.message}`).join("; ")}; fix the points its sender built`,
      );
    }
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      declareInstruments(sql, parsed.data.instruments, Date.now());
      checkKinds(sql, parsed.data);
    });
    bufferBatch(this.pending, parsed.data, METRICS_LIMITS);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + METRICS_FLUSH_MS);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const failed = await this.flush(now).then(() => null, errorOf);
    if (failed === null) {
      this.retries = 0;
      if (this.pending.size > 0) await this.ctx.storage.setAlarm(now + METRICS_FLUSH_MS);
      return;
    }
    this.retries += 1;
    if (this.retries > RETRY_LIMIT) {
      console.error(
        `MetricsFlushFailed: tenant ${this.ctx.id.name} dropped ${this.unwritten.length} metric windows after ${RETRY_LIMIT} retries: ${failed.message}`,
      );
      this.retries = 0;
      this.unwritten = [];
      this.catalogUnwritten = false;
      this.loadedCatalog = undefined;
      if (this.pending.size > 0) await this.ctx.storage.setAlarm(now + METRICS_FLUSH_MS);
      return;
    }
    console.error(
      `MetricsFlushRetry: tenant ${this.ctx.id.name} retry ${this.retries} of ${RETRY_LIMIT} storing metric windows: ${failed.message}`,
    );
    await this.ctx.storage.setAlarm(now + backoffMs(this.retries, FLUSH_FIRST_RETRY_MS));
  }

  async catalog(query: MetricWindow): Promise<Outcome<MetricCatalog>> {
    const catalog = await this.catalogNow();
    return readCatalog(instrumentsOf(this.ctx.storage.sql), catalog.series, query);
  }

  async query(metric: string, query: MetricSeriesQuery): Promise<Outcome<MetricSeriesSet>> {
    const planned = planSeriesQuery(query, Date.now(), METRICS_LIMITS);
    if (!planned.ok) return planned;
    const instrument = instrumentOrRefusal(metric, instrumentOf(this.ctx.storage.sql, metric));
    if (!instrument.ok) return instrument;
    const { plan, filter } = planned.value;
    const series = filteredSeries((await this.catalogNow()).series, filter, metric);
    const docs = await Promise.all(
      this.windowKeys(plan.resolution, plan.first, plan.to, false).map((key) => this.readWindow(key)),
    );
    return {
      ok: true,
      value: seriesSet(
        instrument.value,
        query,
        plan,
        series,
        docs.flatMap((doc) => doc.rollups),
      ),
    };
  }

  async turns(metric: string, query: MetricTurnQuery): Promise<Outcome<MetricTurnPage>> {
    const planned = planTurnQuery(query);
    if (!planned.ok) return planned;
    const instrument = instrumentOrRefusal(metric, instrumentOf(this.ctx.storage.sql, metric));
    if (!instrument.ok) return instrument;
    const plan = planned.value;
    const series = new Map(
      filteredSeries((await this.catalogNow()).series, plan.filter, metric).map((each) => [each.seriesId, each]),
    );
    const from = Math.max(plan.from, plan.after?.at ?? plan.from);
    const found: StoredTurn[] = [];
    for (const key of this.windowKeys("Minute", from, plan.to, true)) {
      found.push(...turnsOfWindow((await this.readWindow(key)).turns, series, query, plan));
      if (found.length > TURN_PAGE_SIZE) break;
    }
    return { ok: true, value: turnPage(found, series, query, plan) };
  }

  private windowKeys(resolution: Resolution, from: number, to: number, withTurns: boolean): string[] {
    return this.ctx.storage.sql
      .exec<{ storage_key: string }>(
        "SELECT storage_key FROM metric_window WHERE resolution = ? AND window_start > ? AND window_start < ? AND turn_count >= ? ORDER BY window_start",
        resolution,
        from - WINDOW_MS[resolution],
        to,
        withTurns ? 1 : 0,
      )
      .toArray()
      .map((row) => row.storage_key);
  }

  private async readWindow(key: string): Promise<WindowDoc> {
    const object = await this.env.STORE.get(key);
    if (object === null) return EMPTY_WINDOW;
    return parseWindow(await object.text());
  }

  private prefix(): string {
    const tenantId = this.ctx.id.name;
    if (tenantId === undefined) throw new Error("the metrics store was reached by id, not by its tenant name");
    return tenantId;
  }

  private windowKey(resolution: Resolution, windowStart: number): string {
    return `${this.prefix()}/metrics/${resolution.toLowerCase()}/${new Date(windowStart).toISOString()}.json`;
  }

  private async catalogNow(): Promise<Catalog> {
    if (this.loadedCatalog !== undefined) return this.loadedCatalog;
    const object = await this.env.STORE.get(`${this.prefix()}/metrics/catalog.json`);
    const loaded = object === null ? EMPTY_CATALOG : parseCatalog(await object.text());
    this.loadedCatalog ??= loaded;
    return this.loadedCatalog;
  }

  private async flush(now: number): Promise<void> {
    const catalog = await this.catalogNow();
    if (this.pending.size > 0) {
      const resolved = resolvePending(catalog, this.pending, now, METRICS_LIMITS);
      this.pending = new Map();
      this.loadedCatalog = resolved.catalog;
      this.catalogUnwritten ||= resolved.changed;
      this.unwritten = mergeUpdates(this.unwritten, resolved.updates);
    }
    if (this.catalogUnwritten) {
      await this.writeCatalog(this.loadedCatalog ?? catalog);
      this.catalogUnwritten = false;
    }
    for (const update of [...this.unwritten]) {
      await this.writeWindow(update);
      this.unwritten = this.unwritten.filter((held) => held !== update);
    }
    await this.expire(now);
  }

  private async writeCatalog(catalog: Catalog): Promise<void> {
    const key = `${this.prefix()}/metrics/catalog.json`;
    const body = JSON.stringify(catalog);
    await this.env.STORE.put(key, body);
    this.ctx.storage.sql.exec(
      "INSERT INTO metric_catalog (catalog_id, storage_key, digest, bytes, series_count) VALUES (1, ?, ?, ?, ?) ON CONFLICT (catalog_id) DO UPDATE SET storage_key = excluded.storage_key, digest = excluded.digest, bytes = excluded.bytes, series_count = excluded.series_count",
      key,
      await sha256Hex(body),
      body.length,
      catalog.series.length,
    );
  }

  private async writeWindow(update: WindowUpdate): Promise<void> {
    const key = this.windowKey(update.resolution, update.windowStart);
    const doc = mergeWindow(await this.readWindow(key), update);
    const body = JSON.stringify(doc);
    await this.env.STORE.put(key, body);
    this.ctx.storage.sql.exec(
      "INSERT INTO metric_window (resolution, window_start, storage_key, digest, bytes, rollup_count, turn_count) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (resolution, window_start) DO UPDATE SET storage_key = excluded.storage_key, digest = excluded.digest, bytes = excluded.bytes, rollup_count = excluded.rollup_count, turn_count = excluded.turn_count",
      update.resolution,
      update.windowStart,
      key,
      await sha256Hex(body),
      body.length,
      doc.rollups.length,
      doc.turns.length,
    );
  }

  private async expire(now: number): Promise<void> {
    for (const resolution of ["Minute", "Hour"] as const) {
      const expired = this.ctx.storage.sql
        .exec<{ window_start: number; storage_key: string }>(
          "SELECT window_start, storage_key FROM metric_window WHERE resolution = ? AND window_start <= ? ORDER BY window_start LIMIT ?",
          resolution,
          now - windowRetentionMs(resolution, METRICS_LIMITS) - WINDOW_MS[resolution],
          METRICS_LIMITS.expiredWindowsPerFlush,
        )
        .toArray();
      if (expired.length === 0) continue;
      await this.env.STORE.delete(expired.map((row) => row.storage_key));
      for (const { window_start } of expired) {
        this.ctx.storage.sql.exec(
          "DELETE FROM metric_window WHERE resolution = ? AND window_start = ?",
          resolution,
          window_start,
        );
      }
    }
  }
}
