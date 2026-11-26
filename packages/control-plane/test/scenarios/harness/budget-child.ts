import { readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { deserialize, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { budgetClock, cpuMs, D1Database, R2Bucket, Runtime, Storage } from "./runtime.ts";
import type { BudgetCase, Seeded } from "./world.ts";

register("./hooks.mjs", import.meta.url);
setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

const [path = "", given = ""] = process.argv.slice(2);
const seeded = deserialize(readFileSync(path)) as Seeded;
const budgetCase = JSON.parse(given) as BudgetCase;
const source = new URL("../../../src/", import.meta.url);
const { Tenant } = await import(new URL("tenant.ts", source).href);
const { tenantApi } = await import(new URL("tenant-api.ts", source).href);

const runtime = new Runtime(seeded.now);
const db = new DatabaseSync(":memory:");
db.deserialize(seeded.db);
const env: Record<string, unknown> = { ...seeded.vars, DB: new D1Database(db), STORE: new R2Bucket(seeded.store) };
const tenants = runtime.namespace(Tenant, () => env);
env.TENANT = tenants;
const { object, ctx } = tenants.open(seeded.tenantId, new Storage(seeded.tenant));
await ctx.unblocked();
await runtime.settle();

const timed = async (step: () => Promise<unknown>): Promise<number> => {
  budgetClock();
  collectGarbage();
  const started = cpuMs();
  await step();
  return cpuMs() - started;
};

const measured = async (): Promise<number[]> => {
  if (budgetCase.kind === "Operation") {
    const api = tenantApi(tenants, seeded.tenantId);
    return [
      await timed(() =>
        api.call(budgetCase.operation, budgetCase.input).catch((error: unknown) => {
          if (error instanceof Error && /as invalid:/.test(error.message)) throw error;
        }),
      ),
    ];
  }
  const steps: number[] = [];
  for (let at = ctx.storage.alarmAt; at !== null && at <= Date.now(); at = ctx.storage.alarmAt) {
    ctx.storage.alarmAt = null;
    await ctx.unblocked();
    steps.push(await timed(() => (object as { alarm(): Promise<void> }).alarm()));
    await runtime.settle();
  }
  return steps;
};

process.stdout.write(`${JSON.stringify({ ms: await measured() })}\n`);
process.exit(0);
