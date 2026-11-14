import { DurableObject } from "cloudflare:workers";
import { migrateDurableObject } from "./durable-migrate";
import type { Env } from "./index";
import { TENANT_MIGRATIONS } from "./tenant-migrations";

export class Tenant extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateDurableObject(ctx.storage.sql, TENANT_MIGRATIONS);
    });
  }
}
