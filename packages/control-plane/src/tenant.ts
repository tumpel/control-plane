import {
  type HarnessPinCreateSchema,
  HarnessPinSchema,
  PersonaSchema,
  type SecretSetCreateSchema,
  SecretSetSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { migrateDurableObject } from "./durable-migrate";
import { seal } from "./envelope.ts";
import { type GitHubUser, REPOSITORY_TOKEN } from "./github.ts";
import type { Env } from "./index";
import { type LegacyMember, legacyMembers, type PlaintextRow } from "./legacy-secrets.ts";
import type { StoredFile } from "./persona-files";
import { TenantClaudeSetups } from "./tenant-claude-setups";
import { TENANT_MIGRATIONS } from "./tenant-migrations";
import { memberRows, sealContext, toKey } from "./tenant-sessions";

export type Persona = z.infer<typeof PersonaSchema>;
export type PersonaWrite = Pick<Persona, "name" | "harness" | "secretSetId"> & {
  files: StoredFile[];
};
export type PersonaChange = Omit<PersonaWrite, "harness">;
export type SecretSet = z.infer<typeof SecretSetSchema>;
export type SecretSetWrite = z.infer<typeof SecretSetCreateSchema>;
export type HarnessPin = z.infer<typeof HarnessPinSchema>;
export type HarnessPinWrite = z.infer<typeof HarnessPinCreateSchema>;

export type Written<T> = { ok: true; value: T } | { ok: false; constraint: string };

export type SecretSetDeleted = { kind: "Deleted" } | { kind: "NotFound" } | { kind: "InUse"; personas: string[] };

export type SecretMemberRemoved =
  | { kind: "Removed"; secretSet: SecretSet }
  | { kind: "SetNotFound" }
  | { kind: "MemberNotFound" };

export type PersonaDeleted = { kind: "Deleted" } | { kind: "NotFound" } | { kind: "InUse"; sessions: string[] };

type SecretMember = SecretSetWrite["secrets"][number];

type SealedMember = { member: SecretMember; sealed: string };

const UNIQUE_FAILED = "UNIQUE constraint failed: ";

const uniquely = <T>(write: () => T): Written<T> => {
  try {
    return { ok: true, value: write() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const at = error.message.indexOf(UNIQUE_FAILED);
    if (at === -1) throw error;
    return { ok: false, constraint: error.message.slice(at + UNIQUE_FAILED.length).split(":")[0] ?? "" };
  }
};

const DEFAULT_PERSONA = { name: "Default", harness: "ClaudeCode" };
const DEFAULT_SECRET_SET = "Default";

type PersonaRow = {
  persona_id: string;
  tenant_id: string;
  name: string;
  harness: string;
  secret_set_id: string;
  created_at: number;
  updated_at: number;
};

type PersonaFileRow = {
  path: string;
  digest: string;
  size_bytes: number;
  created_at: number;
  updated_at: number;
};

const PERSONA_SELECT =
  "SELECT persona_id, tenant_id, name, harness, secret_set_id, created_at, updated_at FROM personas";

export const personaFileRows = (sql: SqlStorage, personaId: string): PersonaFileRow[] =>
  sql
    .exec<PersonaFileRow>(
      "SELECT path, digest, size_bytes, created_at, updated_at FROM persona_files WHERE persona_id = ? ORDER BY path",
      personaId,
    )
    .toArray();

const toPersona = (row: PersonaRow, files: PersonaFileRow[]): Persona =>
  PersonaSchema.parse({
    personaId: row.persona_id,
    tenantId: row.tenant_id,
    name: row.name,
    harness: row.harness,
    secretSetId: row.secret_set_id,
    files: files.map((file) => ({
      path: file.path,
      digest: file.digest,
      sizeBytes: file.size_bytes,
      createdAt: file.created_at,
      updatedAt: file.updated_at,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

type SecretSetRow = { secret_set_id: string; name: string; created_at: number; updated_at: number };
type HarnessPinRow = { harness: string; harness_version: string; updated_at: number };

const toPin = (row: HarnessPinRow): HarnessPin =>
  HarnessPinSchema.parse({ harness: row.harness, harnessVersion: row.harness_version, updatedAt: row.updated_at });

export class Tenant extends TenantClaudeSetups {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateDurableObject(ctx.storage.sql, TENANT_MIGRATIONS);
      await this.holdDataKey();
      await this.sealPlaintext();
    });
  }

  private async sealPlaintext(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const [table] = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'secret_values_plaintext'",
      )
      .toArray();
    if (table === undefined) return;
    const rows = sql
      .exec<PlaintextRow>(
        "SELECT secret_set_id, name, provider, value, updated_at FROM secret_values_plaintext ORDER BY secret_set_id, name",
      )
      .toArray();
    if (rows.length === 0) {
      sql.exec("DROP TABLE secret_values_plaintext");
      return;
    }
    const dataKey = await this.dataKey();
    const sealed: { member: LegacyMember; sealed: string }[] = [];
    for (const member of legacyMembers(rows)) {
      sealed.push({
        member,
        sealed: await seal(dataKey, member.row.value, sealContext(member.row.secret_set_id, member.name)),
      });
    }
    this.ctx.storage.transactionSync(() => {
      for (const { member, sealed: value } of sealed) {
        sql.exec(
          "INSERT INTO secret_values (secret_set_id, name, kind, sealed, updated_at) VALUES (?, ?, ?, ?, ?)",
          member.row.secret_set_id,
          member.name,
          member.kind,
          value,
          member.row.updated_at,
        );
        if (member.kind === "ApiKey") {
          sql.exec(
            "INSERT INTO secret_credentials (secret_set_id, name, provider) VALUES (?, ?, ?)",
            member.row.secret_set_id,
            member.name,
            member.row.provider,
          );
        }
      }
      sql.exec("DROP TABLE secret_values_plaintext");
    });
  }

  open(tenantId: string, now: number): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const [existing] = sql.exec<{ persona_id: string }>("SELECT persona_id FROM personas LIMIT 1").toArray();
      if (existing !== undefined) return;
      const secretSetId = crypto.randomUUID();
      sql.exec(
        "INSERT INTO secret_sets (secret_set_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        secretSetId,
        DEFAULT_SECRET_SET,
        now,
        now,
      );
      sql.exec(
        "INSERT INTO personas (persona_id, tenant_id, name, harness, secret_set_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        tenantId,
        DEFAULT_PERSONA.name,
        DEFAULT_PERSONA.harness,
        secretSetId,
        now,
        now,
      );
    });
  }

  private persona(row: PersonaRow): Persona {
    return toPersona(row, personaFileRows(this.ctx.storage.sql, row.persona_id));
  }

  listPersonas(tenantId: string): Persona[] {
    return this.ctx.storage.sql
      .exec<PersonaRow>(`${PERSONA_SELECT} WHERE tenant_id = ? ORDER BY created_at, persona_id`, tenantId)
      .toArray()
      .map((row) => this.persona(row));
  }

  getPersona(tenantId: string, personaId: string): Persona | null {
    const [row] = this.ctx.storage.sql
      .exec<PersonaRow>(`${PERSONA_SELECT} WHERE tenant_id = ? AND persona_id = ?`, tenantId, personaId)
      .toArray();
    return row === undefined ? null : this.persona(row);
  }

  private writeFiles(personaId: string, files: readonly StoredFile[], now: number): void {
    const sql = this.ctx.storage.sql;
    const kept = new Set(files.map((file) => file.path));
    for (const held of personaFileRows(sql, personaId).filter((row) => !kept.has(row.path))) {
      sql.exec("DELETE FROM persona_files WHERE persona_id = ? AND path = ?", personaId, held.path);
    }
    for (const file of files) {
      sql.exec(
        `INSERT INTO persona_files (persona_id, path, digest, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (persona_id, path) DO UPDATE SET digest = excluded.digest, size_bytes = excluded.size_bytes, updated_at = excluded.updated_at
        WHERE persona_files.digest != excluded.digest`,
        personaId,
        file.path,
        file.digest,
        file.sizeBytes,
        now,
        now,
      );
    }
  }

  createPersona(tenantId: string, persona: PersonaWrite, now: number): Written<Persona> {
    const personaId = crypto.randomUUID();
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO personas (persona_id, tenant_id, name, harness, secret_set_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          personaId,
          tenantId,
          persona.name,
          persona.harness,
          persona.secretSetId,
          now,
          now,
        );
        this.writeFiles(personaId, persona.files, now);
      }),
    );
    if (!written.ok) return written;
    const created = this.getPersona(tenantId, personaId);
    if (created === null) throw new Error(`persona ${personaId} was created and then not found`);
    return { ok: true, value: created };
  }

  updatePersona(tenantId: string, personaId: string, persona: PersonaChange, now: number): Written<Persona | null> {
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        const updated = this.ctx.storage.sql.exec(
          "UPDATE personas SET name = ?, secret_set_id = ?, updated_at = ? WHERE tenant_id = ? AND persona_id = ?",
          persona.name,
          persona.secretSetId,
          now,
          tenantId,
          personaId,
        );
        if (updated.rowsWritten === 0) return false;
        this.writeFiles(personaId, persona.files, now);
        return true;
      }),
    );
    if (!written.ok) return written;
    return { ok: true, value: written.value ? this.getPersona(tenantId, personaId) : null };
  }

  deletePersona(tenantId: string, personaId: string): PersonaDeleted {
    const sql = this.ctx.storage.sql;
    const sessions = sql
      .exec<{ session_id: string }>(
        "SELECT session_id FROM sessions WHERE persona_id = ? ORDER BY created_at, session_id",
        personaId,
      )
      .toArray()
      .map((row) => row.session_id);
    if (sessions.length > 0) return { kind: "InUse", sessions };
    const deleted =
      sql.exec("DELETE FROM personas WHERE tenant_id = ? AND persona_id = ?", tenantId, personaId).rowsWritten > 0;
    return deleted ? { kind: "Deleted" } : { kind: "NotFound" };
  }

  private secretSetsWhere(tenantId: string, where: string, ...bindings: string[]): SecretSet[] {
    const sql = this.ctx.storage.sql;
    return sql
      .exec<SecretSetRow>(
        `SELECT secret_set_id, name, created_at, updated_at FROM secret_sets${where} ORDER BY created_at, secret_set_id`,
        ...bindings,
      )
      .toArray()
      .map((row) =>
        SecretSetSchema.parse({
          secretSetId: row.secret_set_id,
          tenantId,
          name: row.name,
          keys: memberRows(sql, row.secret_set_id).map(toKey),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      );
  }

  listSecretSets(tenantId: string): SecretSet[] {
    return this.secretSetsWhere(tenantId, "");
  }

  getSecretSet(tenantId: string, secretSetId: string): SecretSet | null {
    return this.secretSetsWhere(tenantId, " WHERE secret_set_id = ?", secretSetId)[0] ?? null;
  }

  private async sealMembers(secretSetId: string, secrets: readonly SecretMember[]): Promise<SealedMember[]> {
    if (secrets.length === 0) return [];
    const dataKey = await this.dataKey();
    const sealed: SealedMember[] = [];
    for (const member of secrets) {
      sealed.push({ member, sealed: await seal(dataKey, member.value, sealContext(secretSetId, member.name)) });
    }
    return sealed;
  }

  private writeGitHubUser(secretSetId: string, githubUser: GitHubUser | null, now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM secret_set_github_users WHERE secret_set_id = ?", secretSetId);
    if (githubUser === null) return;
    sql.exec(
      "INSERT INTO secret_set_github_users (secret_set_id, github_user_id, login, created_at) VALUES (?, ?, ?, ?)",
      secretSetId,
      githubUser.githubUserId,
      githubUser.login,
      now,
    );
  }

  private writeMember(secretSetId: string, { member, sealed }: SealedMember, now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT INTO secret_values (secret_set_id, name, kind, sealed, updated_at) VALUES (?, ?, ?, ?, ?)",
      secretSetId,
      member.name,
      member.kind,
      sealed,
      now,
    );
    if (member.kind === "Variable") return;
    sql.exec(
      "INSERT INTO secret_credentials (secret_set_id, name, provider) VALUES (?, ?, ?)",
      secretSetId,
      member.name,
      member.provider,
    );
    if (member.kind === "ApiKey") return;
    sql.exec(
      "INSERT INTO secret_expiries (secret_set_id, name, expires_at) VALUES (?, ?, ?)",
      secretSetId,
      member.name,
      member.expiresAt,
    );
  }

  private writeSecrets(
    secretSetId: string,
    secrets: readonly SealedMember[],
    githubUser: GitHubUser | null,
    now: number,
  ): void {
    this.ctx.storage.sql.exec("DELETE FROM secret_values WHERE secret_set_id = ?", secretSetId);
    this.writeGitHubUser(secretSetId, githubUser, now);
    for (const member of secrets) this.writeMember(secretSetId, member, now);
  }

  async createSecretSet(
    tenantId: string,
    secretSet: SecretSetWrite,
    githubUser: GitHubUser | null,
    now: number,
  ): Promise<Written<SecretSet>> {
    const secretSetId = crypto.randomUUID();
    const sealed = await this.sealMembers(secretSetId, secretSet.secrets);
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO secret_sets (secret_set_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          secretSetId,
          secretSet.name,
          now,
          now,
        );
        this.writeSecrets(secretSetId, sealed, githubUser, now);
      }),
    );
    if (!written.ok) return written;
    const created = this.getSecretSet(tenantId, secretSetId);
    if (created === null) throw new Error(`secret set ${secretSetId} was created and then not found`);
    return { ok: true, value: created };
  }

  async updateSecretSet(
    tenantId: string,
    secretSetId: string,
    secretSet: SecretSetWrite,
    githubUser: GitHubUser | null,
    now: number,
  ): Promise<Written<SecretSet | null>> {
    const sealed = await this.sealMembers(secretSetId, secretSet.secrets);
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        const updated = this.ctx.storage.sql.exec(
          "UPDATE secret_sets SET name = ?, updated_at = ? WHERE secret_set_id = ?",
          secretSet.name,
          now,
          secretSetId,
        );
        if (updated.rowsWritten === 0) return false;
        this.writeSecrets(secretSetId, sealed, githubUser, now);
        return true;
      }),
    );
    if (!written.ok) return written;
    return { ok: true, value: written.value ? this.getSecretSet(tenantId, secretSetId) : null };
  }

  async setSecretMember(
    tenantId: string,
    secretSetId: string,
    member: SecretMember,
    githubUser: GitHubUser | null,
    now: number,
  ): Promise<Written<SecretSet | null>> {
    if (!this.hasSecretSet(secretSetId)) return { ok: true, value: null };
    const sealed = await this.sealMembers(secretSetId, [member]);
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        sql.exec("DELETE FROM secret_values WHERE secret_set_id = ? AND name = ?", secretSetId, member.name);
        for (const each of sealed) this.writeMember(secretSetId, each, now);
        if (member.name === REPOSITORY_TOKEN) this.writeGitHubUser(secretSetId, githubUser, now);
        sql.exec("UPDATE secret_sets SET updated_at = ? WHERE secret_set_id = ?", now, secretSetId);
      }),
    );
    if (!written.ok) return written;
    return { ok: true, value: this.getSecretSet(tenantId, secretSetId) };
  }

  removeSecretMember(tenantId: string, secretSetId: string, name: string, now: number): SecretMemberRemoved {
    if (!this.hasSecretSet(secretSetId)) return { kind: "SetNotFound" };
    const sql = this.ctx.storage.sql;
    const removed = this.ctx.storage.transactionSync(() => {
      const deleted = sql.exec("DELETE FROM secret_values WHERE secret_set_id = ? AND name = ?", secretSetId, name);
      if (deleted.rowsWritten === 0) return false;
      if (name === REPOSITORY_TOKEN) this.writeGitHubUser(secretSetId, null, now);
      sql.exec("UPDATE secret_sets SET updated_at = ? WHERE secret_set_id = ?", now, secretSetId);
      return true;
    });
    const secretSet = this.getSecretSet(tenantId, secretSetId);
    if (secretSet === null) throw new Error(`secret set ${secretSetId} vanished while a member was removed`);
    return removed ? { kind: "Removed", secretSet } : { kind: "MemberNotFound" };
  }

  deleteSecretSet(secretSetId: string): SecretSetDeleted {
    const sql = this.ctx.storage.sql;
    const personas = sql
      .exec<{ name: string }>("SELECT name FROM personas WHERE secret_set_id = ? ORDER BY name", secretSetId)
      .toArray()
      .map((row) => row.name);
    if (personas.length > 0) return { kind: "InUse", personas };
    const deleted = sql.exec("DELETE FROM secret_sets WHERE secret_set_id = ?", secretSetId).rowsWritten > 0;
    return deleted ? { kind: "Deleted" } : { kind: "NotFound" };
  }

  hasSecretSet(secretSetId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ secret_set_id: string }>("SELECT secret_set_id FROM secret_sets WHERE secret_set_id = ?", secretSetId)
        .toArray().length > 0
    );
  }

  listPins(): HarnessPin[] {
    return this.ctx.storage.sql
      .exec<HarnessPinRow>("SELECT harness, harness_version, updated_at FROM harness_pins ORDER BY harness")
      .toArray()
      .map(toPin);
  }

  pin(pin: HarnessPinWrite, now: number): HarnessPin {
    this.ctx.storage.sql.exec(
      `INSERT INTO harness_pins (harness, harness_version, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (harness) DO UPDATE SET harness_version = excluded.harness_version, updated_at = excluded.updated_at`,
      pin.harness,
      pin.harnessVersion,
      now,
    );
    return { ...pin, updatedAt: now };
  }

  unpin(harness: string): boolean {
    return this.ctx.storage.sql.exec("DELETE FROM harness_pins WHERE harness = ?", harness).rowsWritten > 0;
  }
}
