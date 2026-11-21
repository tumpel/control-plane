import assert from "node:assert/strict";
import { test } from "node:test";
import { HostFrameSchema } from "@tumpel/schemas";
import type { z } from "zod";
import { TENANT_OPERATIONS } from "../../src/tenant-api.ts";
import { PRINCIPAL_ID, TENANT_ID, World } from "./harness/world.ts";

const BUDGET_MS = 30;
const WARM_UPS = 8;
const RUNS = 5;

type Def = { type: string } & Record<string, unknown>;
type Known = Record<string, unknown>;

const STRINGS = [
  "x",
  "00000000-0000-4000-8000-000000000000",
  "https://scenario.test/x",
  "2026-11-21T11:00:00.000Z",
  "a".repeat(64),
  "x@scenario.test",
  "main",
];

const defOf = (schema: unknown): Def => (schema as { _zod: { def: Def } })._zod.def;

const generate = (schema: unknown, known: Known, key: string): unknown => {
  const def = defOf(schema);
  const accepts = (value: unknown) => (schema as z.ZodType).safeParse(value).success;
  const first = (candidates: unknown[]) => {
    const found = candidates.find(accepts);
    if (found === undefined) throw new Error(`no value for ${def.type} at ${key}`);
    return found;
  };
  if (key in known && accepts(known[key])) return known[key];
  switch (def.type) {
    case "string":
      return first(STRINGS);
    case "number":
    case "int": {
      const limits = ((def.checks ?? []) as { _zod: { def: { value?: unknown } } }[]).flatMap((check) => {
        const value = check._zod.def.value;
        return typeof value === "number" ? [value, value + 1, value - 1] : [];
      });
      return first([...limits, 1, 0, 2, 8, 100, 1024, 4096, 65536, Date.now()]);
    }
    case "boolean":
      return first([true, false]);
    case "enum":
      return Object.values(def.entries as Record<string, unknown>)[0];
    case "literal":
      return (def.values as unknown[])[0];
    case "null":
      return null;
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(def.shape as Record<string, unknown>)) {
        if (defOf(field).type === "optional") continue;
        out[name] = generate(field, known, name);
      }
      return out;
    }
    case "array":
      return [];
    case "record":
      return {};
    case "optional":
      return generate(def.innerType, known, key);
    case "nullable":
      return generate(def.innerType, known, key);
    case "default":
    case "readonly":
    case "catch":
    case "nonoptional":
      return generate(def.innerType, known, key);
    case "pipe":
      return generate(def.in, known, key);
    case "lazy":
      return generate((def.getter as () => unknown)(), known, key);
    case "union": {
      for (const option of def.options as unknown[]) {
        const value = generate(option, known, key);
        if (accepts(value)) return value;
      }
      throw new Error(`no union member accepts a generated value at ${key}`);
    }
    case "intersection":
      return { ...(generate(def.left, known, key) as object), ...(generate(def.right, known, key) as object) };
    default:
      return first([undefined, null, {}, [], "x", 1]);
  }
};

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const measured = async (action: () => Promise<number>): Promise<number> => {
  for (let at = 0; at < WARM_UPS; at++) await action();
  const runs: number[] = [];
  for (let at = 0; at < RUNS; at++) runs.push(await action());
  return median(runs);
};

const report = (over: [string, number][]) => over.map(([name, ms]) => `${name}: ${ms.toFixed(1)} ms`).join("\n");

const world_ = async (t: { after(fn: () => void): void }) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const session = await world.startSession({ prompt: "budget", tags: [] });
  const known: Known = {
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    hostId: host.hostId,
    sessionId: session.sessionId,
    now: Date.now(),
  };
  return { world, known };
};

const settle = async (
  world: World,
  name: string,
  build: () => unknown,
  over: [string, number][],
  broken: string[],
  label = name,
): Promise<void> => {
  const failed = (error: unknown) => broken.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  let input: unknown;
  try {
    input = build();
  } catch (error) {
    failed(error);
    return;
  }
  const ms = await measured(() => world.computeMs(name, input)).catch((error: unknown) => {
    failed(error);
    return 0;
  });
  if (ms > BUDGET_MS) over.push([label, ms]);
};

test("every Tenant API operation computes within the 30 ms budget", async (t) => {
  const { world, known } = await world_(t);
  const over: [string, number][] = [];
  const broken: string[] = [];
  for (const [name, operation] of Object.entries(TENANT_OPERATIONS)) {
    if (name === "hostMessage") continue;
    await settle(world, name, () => generate(operation.input, known, name), over, broken);
  }
  assert.deepEqual(broken, [], `operations the test could not run:\n${broken.join("\n")}`);
  assert.deepEqual(over, [], `operations over ${BUDGET_MS} ms of compute:\n${report(over)}`);
});

test("every host channel frame computes within the 30 ms budget", async (t) => {
  const { world, known } = await world_(t);
  const over: [string, number][] = [];
  const broken: string[] = [];
  const members = HostFrameSchema.shape.message as unknown as z.ZodType as unknown;
  for (const option of defOf(members).options as unknown[]) {
    const type = String((defOf((defOf(option).shape as Record<string, unknown>).type).values as unknown[])[0]);
    const operation =
      type === "SupervisorUpdateStep" || type === "SupervisorUpdateFailed"
        ? "supervisorUpdate"
        : type === "TelemetryBatch"
          ? "turnMetricDimensions"
          : "hostMessage";
    await settle(
      world,
      operation,
      () => {
        const message = generate(option, known, "message");
        if (operation === "supervisorUpdate") return { hostId: known.hostId, message };
        if (operation === "turnMetricDimensions") return { turnIds: [] };
        return { tenantId: TENANT_ID, hostId: known.hostId, message };
      },
      over,
      broken,
      type,
    );
  }
  assert.deepEqual(broken, [], `frames the test could not run:\n${broken.join("\n")}`);
  assert.deepEqual(over, [], `frames over ${BUDGET_MS} ms of compute:\n${report(over)}`);
});
