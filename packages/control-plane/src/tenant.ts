import { DurableObject } from "cloudflare:workers";
import { PersonaSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { migrateDurableObject } from "./durable-migrate";
import type { Env } from "./index";
import { TENANT_MIGRATIONS } from "./tenant-migrations";

export type Persona = z.infer<typeof PersonaSchema>;

const DEFAULT_PERSONA = { name: "Default", instructions: "", settings: "{}", mcpServers: [] };

type PersonaRow = {
  persona_id: string;
  tenant_id: string;
  name: string;
  instructions: string;
  settings: string;
  mcp_servers: string;
  created_at: number;
  updated_at: number;
};

const PERSONA_SELECT =
  "SELECT persona_id, tenant_id, name, instructions, settings, mcp_servers, created_at, updated_at FROM personas";

const toPersona = (row: PersonaRow): Persona =>
  PersonaSchema.parse({
    personaId: row.persona_id,
    tenantId: row.tenant_id,
    name: row.name,
    instructions: row.instructions,
    settings: row.settings,
    mcpServers: JSON.parse(row.mcp_servers),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

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
      const [existing] = sql.exec<{ persona_id: string }>("SELECT persona_id FROM personas LIMIT 1").toArray();
      if (existing !== undefined) return;
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

  listPersonas(tenantId: string): Persona[] {
    return this.ctx.storage.sql
      .exec<PersonaRow>(`${PERSONA_SELECT} WHERE tenant_id = ? ORDER BY created_at, persona_id`, tenantId)
      .toArray()
      .map(toPersona);
  }

  getPersona(tenantId: string, personaId: string): Persona | null {
    const [row] = this.ctx.storage.sql
      .exec<PersonaRow>(`${PERSONA_SELECT} WHERE tenant_id = ? AND persona_id = ?`, tenantId, personaId)
      .toArray();
    return row === undefined ? null : toPersona(row);
  }
}
