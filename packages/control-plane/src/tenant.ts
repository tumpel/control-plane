import { DurableObject } from "cloudflare:workers";
import {
  type HarnessPinCreateSchema,
  HarnessPinSchema,
  type PersonaCreateSchema,
  PersonaSchema,
  type SecretSetCreateSchema,
  SecretSetSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { migrateDurableObject } from "./durable-migrate";
import type { Env } from "./index";
import { TENANT_MIGRATIONS } from "./tenant-migrations";

export type Persona = z.infer<typeof PersonaSchema>;
export type PersonaWrite = z.infer<typeof PersonaCreateSchema>;
export type SecretSet = z.infer<typeof SecretSetSchema>;
export type SecretSetWrite = z.infer<typeof SecretSetCreateSchema>;
export type HarnessPin = z.infer<typeof HarnessPinSchema>;
export type HarnessPinWrite = z.infer<typeof HarnessPinCreateSchema>;

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

type SecretSetRow = { secret_set_id: string; tenant_id: string; name: string; created_at: number; updated_at: number };
type SecretKeyRow = { secret_set_id: string; name: string; provider: string; updated_at: number };
type HarnessPinRow = { harness: string; harness_version: string; updated_at: number };

const toPin = (row: HarnessPinRow): HarnessPin =>
  HarnessPinSchema.parse({ harness: row.harness, harnessVersion: row.harness_version, updatedAt: row.updated_at });

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

  createPersona(tenantId: string, persona: PersonaWrite, now: number): Persona {
    const personaId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO personas (persona_id, tenant_id, name, instructions, settings, mcp_servers, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      personaId,
      tenantId,
      persona.name,
      persona.instructions,
      persona.settings,
      JSON.stringify(persona.mcpServers),
      now,
      now,
    );
    return { ...persona, personaId, tenantId, createdAt: now, updatedAt: now };
  }

  updatePersona(tenantId: string, personaId: string, persona: PersonaWrite, now: number): Persona | null {
    const updated = this.ctx.storage.sql.exec(
      `UPDATE personas SET name = ?, instructions = ?, settings = ?, mcp_servers = ?, updated_at = ?
      WHERE tenant_id = ? AND persona_id = ?`,
      persona.name,
      persona.instructions,
      persona.settings,
      JSON.stringify(persona.mcpServers),
      now,
      tenantId,
      personaId,
    );
    return updated.rowsWritten === 0 ? null : this.getPersona(tenantId, personaId);
  }

  deletePersona(tenantId: string, personaId: string): boolean {
    return (
      this.ctx.storage.sql.exec("DELETE FROM personas WHERE tenant_id = ? AND persona_id = ?", tenantId, personaId)
        .rowsWritten > 0
    );
  }

  private secretSetsWhere(clause: string, ...bindings: string[]): SecretSet[] {
    const sql = this.ctx.storage.sql;
    return sql
      .exec<SecretSetRow>(
        `SELECT secret_set_id, tenant_id, name, created_at, updated_at FROM secret_sets WHERE ${clause} ORDER BY created_at, secret_set_id`,
        ...bindings,
      )
      .toArray()
      .map((row) =>
        SecretSetSchema.parse({
          secretSetId: row.secret_set_id,
          tenantId: row.tenant_id,
          name: row.name,
          keys: sql
            .exec<SecretKeyRow>(
              "SELECT secret_set_id, name, provider, updated_at FROM secret_values WHERE secret_set_id = ? ORDER BY name",
              row.secret_set_id,
            )
            .toArray()
            .map((key) => ({ name: key.name, provider: key.provider, updatedAt: key.updated_at })),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      );
  }

  listSecretSets(tenantId: string): SecretSet[] {
    return this.secretSetsWhere("tenant_id = ?", tenantId);
  }

  getSecretSet(tenantId: string, secretSetId: string): SecretSet | null {
    return this.secretSetsWhere("tenant_id = ? AND secret_set_id = ?", tenantId, secretSetId)[0] ?? null;
  }

  private writeSecrets(secretSetId: string, secrets: SecretSetWrite["secrets"], now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM secret_values WHERE secret_set_id = ?", secretSetId);
    for (const secret of secrets) {
      sql.exec(
        "INSERT INTO secret_values (secret_set_id, name, provider, value, updated_at) VALUES (?, ?, ?, ?, ?)",
        secretSetId,
        secret.name,
        secret.provider,
        secret.value,
        now,
      );
    }
  }

  createSecretSet(tenantId: string, secretSet: SecretSetWrite, now: number): SecretSet {
    const secretSetId = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO secret_sets (secret_set_id, tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        secretSetId,
        tenantId,
        secretSet.name,
        now,
        now,
      );
      this.writeSecrets(secretSetId, secretSet.secrets, now);
    });
    const created = this.getSecretSet(tenantId, secretSetId);
    if (created === null) throw new Error(`secret set ${secretSetId} was created and then not found`);
    return created;
  }

  updateSecretSet(tenantId: string, secretSetId: string, secretSet: SecretSetWrite, now: number): SecretSet | null {
    const found = this.ctx.storage.transactionSync(() => {
      const updated = this.ctx.storage.sql.exec(
        "UPDATE secret_sets SET name = ?, updated_at = ? WHERE tenant_id = ? AND secret_set_id = ?",
        secretSet.name,
        now,
        tenantId,
        secretSetId,
      );
      if (updated.rowsWritten === 0) return false;
      this.writeSecrets(secretSetId, secretSet.secrets, now);
      return true;
    });
    return found ? this.getSecretSet(tenantId, secretSetId) : null;
  }

  deleteSecretSet(tenantId: string, secretSetId: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const deleted = sql.exec(
        "DELETE FROM secret_sets WHERE tenant_id = ? AND secret_set_id = ?",
        tenantId,
        secretSetId,
      );
      if (deleted.rowsWritten === 0) return false;
      sql.exec("DELETE FROM secret_values WHERE secret_set_id = ?", secretSetId);
      return true;
    });
  }

  listPins(tenantId: string): HarnessPin[] {
    return this.ctx.storage.sql
      .exec<HarnessPinRow>(
        "SELECT harness, harness_version, updated_at FROM harness_pins WHERE tenant_id = ? ORDER BY harness",
        tenantId,
      )
      .toArray()
      .map(toPin);
  }

  pin(tenantId: string, pin: HarnessPinWrite, now: number): HarnessPin {
    this.ctx.storage.sql.exec(
      `INSERT INTO harness_pins (harness, tenant_id, harness_version, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (harness) DO UPDATE SET harness_version = excluded.harness_version, updated_at = excluded.updated_at`,
      pin.harness,
      tenantId,
      pin.harnessVersion,
      now,
    );
    return { ...pin, updatedAt: now };
  }

  unpin(tenantId: string, harness: string): boolean {
    return (
      this.ctx.storage.sql.exec("DELETE FROM harness_pins WHERE tenant_id = ? AND harness = ?", tenantId, harness)
        .rowsWritten > 0
    );
  }
}
