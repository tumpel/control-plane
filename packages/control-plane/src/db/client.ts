import type { D1Database, DurableObjectStorage } from "@cloudflare/workers-types/index.ts";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzleDurable } from "drizzle-orm/durable-sqlite";
import * as central from "./central-schema.ts";

export const centralDb = (db: D1Database) => drizzleD1(db, { schema: central });

export const durableDb = <Schema extends Record<string, unknown>>(
  storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
  schema: Schema,
) => drizzleDurable(storage as DurableObjectStorage, { schema });

export type CentralDb = ReturnType<typeof centralDb>;
export type DurableDb<Schema extends Record<string, unknown>> = ReturnType<typeof durableDb<Schema>>;
