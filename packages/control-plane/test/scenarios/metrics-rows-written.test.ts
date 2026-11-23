import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import type { MetricBatch } from "../../src/metrics-store.ts";
import { Runtime } from "./harness/runtime.ts";

register("./harness/hooks.mjs", import.meta.url);

const { TenantMetrics } = (await import(new URL("../../src/tenant-metrics.ts", import.meta.url).href)) as {
  TenantMetrics: new (ctx: never, env: never) => { record(batch: MetricBatch): Promise<void> };
};

const START = Date.parse("2026-11-21T19:00:00Z");
const HEARTBEAT_MS = 10_000;
const TURN_EVERY_HEARTBEATS = 6;
const HOUR_MS = 60 * 60_000;
const BOXES = 9;

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
test("an hour of nine boxes' heartbeats and turns writes every point to Analytics Engine and no Durable Object row per batch", async (t) => {
  const runtime = new Runtime(START);
  t.after(() => runtime.close());
  const written: unknown[] = [];
  const tenants = runtime.namespace(TenantMetrics, () => ({
    METRICS: { writeDataPoint: (point: unknown) => written.push(point) },
    METRICS_DATASET: "tumpel_metrics",
  }));
  const metrics = tenants.getByName("tenant-1");
  const sql = tenants.instance("tenant-1").ctx.storage.sql;

  const first = heartbeat(0, 0, START);
  await metrics.record(first);
  const rowsPerBatch = new Set<number>();
  let points = first.samples.length + first.turns.length;
  let largestCall = 0;
  for (let elapsed = 0, tick = 1; elapsed < HOUR_MS; elapsed += HEARTBEAT_MS, tick++) {
    for (let box = 0; box < BOXES; box++) {
      const batch = heartbeat(box, tick, Date.now());
      const rowsBefore = sql.rowsWritten;
      const pointsBefore = written.length;
      await metrics.record(batch);
      rowsPerBatch.add(sql.rowsWritten - rowsBefore);
      largestCall = Math.max(largestCall, written.length - pointsBefore);
      points += batch.samples.length + batch.turns.length;
    }
    await runtime.advance(HEARTBEAT_MS);
  }

  assert.deepEqual([...rowsPerBatch], [0]);
  assert.equal(written.length, points);
  assert.ok(points > (HOUR_MS / HEARTBEAT_MS) * BOXES * HOST_METRICS.length);
  assert.ok(largestCall <= 250);
});
