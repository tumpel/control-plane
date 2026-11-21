import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageMeter } from "../src/usage-meter.ts";

const MINUTE = 60_000;
const START = 1_800_000_000_000 - (1_800_000_000_000 % MINUTE);

const meterAt = (now: number): UsageMeter =>
  new UsageMeter("Configured", [{ measure: "Requests", window: "Hour", limit: 100 }], [], [], now);

test("the first count saves at once, later counts wait for the end of the minute, and alarm-only counts never arm a save", () => {
  const meter = meterAt(START);

  meter.count(null, START + 1_000, false);
  assert.deepEqual(
    meter.saveDue(START + 1_000)?.map(({ used }) => used),
    [0],
  );
  assert.equal(meter.flushAt(), null);

  meter.count("createSecretSet", START + 2_000, true);
  assert.equal(meter.saveDue(START + 2_000), null);
  assert.equal(meter.flushAt(), START + MINUTE);

  assert.deepEqual(
    meter.saveDue(START + MINUTE)?.map(({ used }) => used),
    [1],
  );
  assert.equal(meter.flushAt(), null);

  meter.count(null, START + MINUTE + 1_000, false);
  assert.equal(meter.saveDue(START + 2 * MINUTE), null);
  assert.equal(meter.flushAt(), null);
});

test("a tier read after the object opened keeps the counts it already holds", () => {
  const meter = meterAt(START);
  meter.count("createSecretSet", START, true);
  meter.count("createSecretSet", START, true);

  meter.retier("Free", [{ measure: "Requests", window: "Hour", limit: 5 }], START + 1_000);

  const usage = meter.usage(START + 1_000);
  assert.equal(usage.tier, "Free");
  assert.deepEqual(
    usage.counters.map(({ used, limit }) => ({ used, limit })),
    [{ used: 2, limit: 5 }],
  );
});
