import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import type { MetricBatch } from "../../src/metrics-store.ts";
import { R2Bucket, Runtime } from "./harness/runtime.ts";

register("./harness/hooks.mjs", import.meta.url);

const { TenantMetrics } = (await import(new URL("../../src/tenant-metrics.ts", import.meta.url).href)) as {
  TenantMetrics: new (ctx: never, env: never) => { record(batch: MetricBatch): Promise<void> };
};

const START = Date.parse("2026-11-21T19:00:00Z");
const HEARTBEAT_MS = 10_000;
const TURN_EVERY_HEARTBEATS = 6;
const BUCKET_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const BOXES = 9;
const ROWS_PER_BUCKET_BOUND = 12;

const HOST_METRICS = [
  "host.cpu.busy",
  "host.load.1m",
  "host.load.5m",
  "host.load.15m",
  "host.memory.available",
  "host.memory.total",
  "host.boxes.running",
  "host.boxes.warm",
  "telemetry.dropped",
];
const TURN_METRICS = ["turn.startup", "turn.phase", "turn.end"];

const INSTRUMENTS: MetricBatch["instruments"] = [
  ...HOST_METRICS.map((metric) => ({ metric, unit: "1", kind: "Sample" as const, description: `Host ${metric}` })),
  ...TURN_METRICS.map((metric) => ({ metric, unit: "s", kind: "Turn" as const, description: `Turn ${metric}` })),
];

const heartbeat = (box: number, tick: number, at: number): MetricBatch => {
  const hostId = `host-${box}`;
  const stamp = new Date(at).toISOString();
  const turnId = `turn-${box}-${tick}`;
  const dimensions = {
    harness: box % 2 === 0 ? "Pi" : "Codex",
    model: `model-${box % 3}`,
    outcome: "Completed",
    hostId,
  };
  return {
    instruments: INSTRUMENTS,
    samples: HOST_METRICS.map((metric, index) => ({
      metric,
      at: stamp,
      value: (tick + index) % 17,
      dimensions: { hostId },
    })),
    turns:
      tick % TURN_EVERY_HEARTBEATS === box % TURN_EVERY_HEARTBEATS
        ? TURN_METRICS.map((metric, index) => ({
            metric,
            at: stamp,
            value: index + (tick % 5),
            dimensions,
            turnId,
            sessionId: `session-${box}`,
          }))
        : [],
  };
};

test(`an hour of nine boxes' heartbeats and turns writes a flat number of tenant metrics rows per 5 minutes, at most ${ROWS_PER_BUCKET_BOUND}`, async (t) => {
  const runtime = new Runtime(START);
  t.after(() => runtime.close());
  const store = new R2Bucket();
  const tenants = runtime.namespace(TenantMetrics, () => ({ STORE: store }));
  const metrics = tenants.getByName("tenant-1");
  const sql = tenants.instance("tenant-1").ctx.storage.sql;

  await metrics.record(heartbeat(0, 0, START));
  await runtime.advance(BUCKET_MS);
  const buckets: number[] = [];
  let bucketStart = sql.totalRowsWritten();
  for (let elapsed = 0, tick = 1; elapsed < HOUR_MS; elapsed += HEARTBEAT_MS, tick++) {
    for (let box = 0; box < BOXES; box++) await metrics.record(heartbeat(box, tick, Date.now()));
    await runtime.advance(HEARTBEAT_MS);
    if ((elapsed + HEARTBEAT_MS) % BUCKET_MS !== 0) continue;
    buckets.push(sql.totalRowsWritten() - bucketStart);
    bucketStart = sql.totalRowsWritten();
  }

  assert.equal(buckets.length, 12);
  assert.ok(
    buckets.every((rows) => rows <= ROWS_PER_BUCKET_BOUND),
    `rows written per 5 minutes ${buckets.join(", ")} pass ${ROWS_PER_BUCKET_BOUND}`,
  );
  const steady = buckets.slice(1);
  assert.ok(
    Math.max(...steady) - Math.min(...steady) <= 1,
    `rows written per 5 minutes ${buckets.join(", ")} are not flat`,
  );
});
