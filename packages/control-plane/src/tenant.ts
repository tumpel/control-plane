import { DurableObject } from "cloudflare:workers";
import { migrateDurableObject } from "./durable-migrate";
import { type Caller, type Whoami, whoamiOf } from "./identity";
import type { Env } from "./index";
import { TENANT_MIGRATIONS } from "./tenant-migrations";

const DEFAULT_PERSONA = { name: "Default", instructions: "", settings: "{}", mcpServers: [] };

export class Tenant extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateDurableObject(ctx.storage.sql, TENANT_MIGRATIONS);
    });
  }

  open(tenantId: string, now: number): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const [owner] = sql.exec<{ tenant_id: string }>("SELECT tenant_id FROM tenant").toArray();
      if (owner !== undefined) {
        this.ownedBy(owner.tenant_id, tenantId);
        return;
      }
      sql.exec("INSERT INTO tenant (tenant_id, created_at) VALUES (?, ?)", tenantId, now);
      sql.exec(
        `INSERT INTO personas (persona_id, tenant_id, name, instructions, settings, mcp_servers, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        tenantId,
        DEFAULT_PERSONA.name,
        DEFAULT_PERSONA.instructions,
        DEFAULT_PERSONA.settings,
        JSON.stringify(DEFAULT_PERSONA.mcpServers),
        now,
        now,
      );
    });
  }

  whoami(caller: Caller): Promise<Whoami> {
    this.check(caller);
    return whoamiOf(this.env.DB, caller);
  }

  private check(caller: Caller): void {
    const [owner] = this.ctx.storage.sql.exec<{ tenant_id: string }>("SELECT tenant_id FROM tenant").toArray();
    if (owner === undefined) {
      throw new Error(`tenant object for ${caller.tenantId} was never opened; sign up again to open it`);
    }
    this.ownedBy(owner.tenant_id, caller.tenantId);
  }

  private ownedBy(owner: string, asked: string): void {
    if (owner !== asked) throw new Error(`tenant object of ${owner} was addressed as ${asked}`);
  }
}
