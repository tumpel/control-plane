import {
  BoxDiskLimit,
  BoxMemoryLimit,
  type HarnessPinCreateSchema,
  HarnessPinSchema,
  type SecretSetCreateSchema,
  SecretSetSchema,
  type SecretSetUpdateSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import type { ConfigWrite } from "./configs.ts";
import { migrateDurableObject } from "./durable-migrate";
import { seal, unseal } from "./envelope.ts";
import { type GitHubUser, REPOSITORY_TOKEN } from "./github.ts";
import type { Env } from "./index";
import { type LegacyMember, legacyMembers, type PlaintextRow } from "./legacy-secrets.ts";
import { type StoredFile, type StoredPersona, StoredPersonaSchema } from "./persona-files";
import { type MemberUpdate, memberWith, planUpdate, storedKeys, type UnreadableSecretSet } from "./secret-members.ts";
import {
  recordSupervisorUpdate,
  type SupervisorUpdateMessage,
  type SupervisorUpdates,
  supervisorUpdatesByHost,
} from "./supervisor-updates";
import { serveTenantRequest, type TenantHandlers, type TenantRequest, type TenantResponse } from "./tenant-api.ts";
import { TenantConnectors } from "./tenant-connectors.ts";
import { TENANT_MIGRATIONS } from "./tenant-migrations";
import { memberRows, sealContext } from "./tenant-sessions";
import { TENANT_RPC_VERSION } from "./tenant-version.ts";

export type PersonaWrite = Pick<StoredPersona, "name" | "harness" | "secretSetId" | "connectorIds" | "boxRetention"> & {
  boxMemoryMib: number;
  boxDiskMib: number;
  files: StoredFile[];
};
export type PersonaChange = Omit<PersonaWrite, "harness">;
export type SecretSet = z.infer<typeof SecretSetSchema>;
export type SecretSetWrite = z.infer<typeof SecretSetCreateSchema>;
export type SecretSetChange = z.infer<typeof SecretSetUpdateSchema>;
export type HarnessPin = z.infer<typeof HarnessPinSchema>;
export type HarnessPinWrite = z.infer<typeof HarnessPinCreateSchema>;

export type Written<T> = { ok: true; value: T } | { ok: false; constraint: string };

export type ConfigApplied =
  | { kind: "Applied" }
  | { kind: "Conflict"; constraint: string }
  | { kind: "Deleted"; resource: string };

const sealedOf = (sealed: Map<string, SealedMember[]>, secretSetId: string): SealedMember[] => {
  const members = sealed.get(secretSetId);
  if (members === undefined) throw new Error(`secret set ${secretSetId} reached the config write unsealed`);
  return members;
};

export type SecretSetDeleted = { kind: "Deleted" } | { kind: "NotFound" } | { kind: "InUse"; personas: string[] };

export type SecretSetsRead = { kind: "Read"; secretSets: SecretSet[] } | UnreadableSecretSet;

export type SecretSetRead = { kind: "Found"; secretSet: SecretSet } | { kind: "NotFound" } | UnreadableSecretSet;

export type SecretSetUpdated =
  | { kind: "Updated"; secretSet: SecretSet }
  | { kind: "SetNotFound" }
  | { kind: "Conflict"; constraint: string }
  | { kind: "NoStoredValue"; name: string; source: string }
  | { kind: "UncheckedToken"; source: string };

export type SecretMemberSet =
  | { kind: "Set"; secretSet: SecretSet }
  | { kind: "SetNotFound" }
  | { kind: "Conflict"; constraint: string }
  | UnreadableSecretSet;

export type SecretMemberRemoved =
  | { kind: "Removed"; secretSet: SecretSet }
  | { kind: "SetNotFound" }
  | { kind: "MemberNotFound" }
  | UnreadableSecretSet;

export type PersonaDeleted = { kind: "Deleted" } | { kind: "NotFound" } | { kind: "InUse"; sessions: string[] };

type SecretMember = SecretSetWrite["secrets"][number];

type SealedMember = { member: MemberUpdate; sealed: string; updatedAt: number };

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
  box_memory_mib: number;
  box_disk_mib: number;
  box_retention: string;
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
  "SELECT persona_id, tenant_id, name, harness, secret_set_id, box_memory_mib, box_disk_mib, box_retention, created_at, updated_at FROM personas";

export const personaFileRows = (sql: SqlStorage, personaId: string): PersonaFileRow[] =>
  sql
    .exec<PersonaFileRow>(
      "SELECT path, digest, size_bytes, created_at, updated_at FROM persona_files WHERE persona_id = ? ORDER BY path",
      personaId,
    )
    .toArray();

const toPersona = (row: PersonaRow, files: PersonaFileRow[], connectorIds: string[]): StoredPersona =>
  StoredPersonaSchema.parse({
    connectorIds,
    personaId: row.persona_id,
    tenantId: row.tenant_id,
    name: row.name,
    harness: row.harness,
    secretSetId: row.secret_set_id,
    boxMemoryMib: row.box_memory_mib,
    boxDiskMib: row.box_disk_mib,
    boxRetention: row.box_retention,
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

export class Tenant extends TenantConnectors {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateDurableObject(ctx.storage.sql, TENANT_MIGRATIONS);
      await this.holdDataKey();
      await this.sealPlaintext();
    });
  }

  rpcVersion(): number {
    return TENANT_RPC_VERSION;
  }

  handle(request: TenantRequest): Promise<TenantResponse> {
    return serveTenantRequest(request, this.operations, () =>
      this.ctx.abort("Tenant API reset onto the deployed code"),
    );
  }

  private readonly operations: TenantHandlers = {
    listPersonas: ({ tenantId }) => ({ personas: this.listPersonas(tenantId) }),
    getPersona: ({ tenantId, personaId }) => ({ persona: this.getPersona(tenantId, personaId) }),
    createPersona: ({ tenantId, persona, now }) => ({ written: this.createPersona(tenantId, persona, now) }),
    updatePersona: ({ tenantId, personaId, persona, now }) => ({
      written: this.updatePersona(tenantId, personaId, persona, now),
    }),
    deletePersona: ({ tenantId, personaId }) => ({ deleted: this.deletePersona(tenantId, personaId) }),
    open: ({ tenantId, now }) => {
      this.open(tenantId, now);
      return {};
    },
    supervisorUpdate: ({ hostId, message }) => {
      this.supervisorUpdate(hostId, message);
      return {};
    },
    supervisorUpdates: ({ hostIds }) => ({ byHost: this.supervisorUpdates(hostIds) }),
    listSecretSets: ({ tenantId }) => ({ read: this.listSecretSets(tenantId) }),
    getSecretSet: ({ tenantId, secretSetId }) => ({ read: this.getSecretSet(tenantId, secretSetId) }),
    createSecretSet: async ({ tenantId, secretSet, githubUser, now }) => ({
      written: await this.createSecretSet(tenantId, secretSet, githubUser, now),
    }),
    updateSecretSet: async ({ tenantId, secretSetId, change, githubUser, now }) => ({
      updated: await this.updateSecretSet(tenantId, secretSetId, change, githubUser, now),
    }),
    setSecretMember: async ({ tenantId, secretSetId, member, githubUser, now }) => ({
      set: await this.setSecretMember(tenantId, secretSetId, member, githubUser, now),
    }),
    removeSecretMember: ({ tenantId, secretSetId, name, now }) => ({
      removed: this.removeSecretMember(tenantId, secretSetId, name, now),
    }),
    deleteSecretSet: ({ secretSetId }) => ({ deleted: this.deleteSecretSet(secretSetId) }),
    applyConfig: async ({ tenantId, writes, now }) => ({ applied: await this.applyConfig(tenantId, writes, now) }),
    listPins: () => ({ pins: this.listPins() }),
    pin: ({ pin, now }) => ({ pin: this.pin(pin, now) }),
    unpin: ({ harness }) => ({ unpinned: this.unpin(harness) }),
    listConnectors: ({ tenantId, now }) => ({ connectors: this.listConnectors(tenantId, now) }),
    getConnector: ({ tenantId, connectorId, now }) => ({ connector: this.getConnector(tenantId, connectorId, now) }),
    createConnector: ({ tenantId, auth, name, url, now }) => ({
      written: this.createConnector(tenantId, auth, name, url, now),
    }),
    renameConnector: ({ tenantId, connectorId, updatedAt, name, now }) => ({
      written: this.renameConnector(tenantId, connectorId, updatedAt, name, now),
    }),
    deleteConnector: ({ connectorId, updatedAt }) => ({ deleted: this.deleteConnector(connectorId, updatedAt) }),
    setStaticToken: async ({ tenantId, connectorId, updatedAt, value, now }) => ({
      written: await this.setStaticToken(tenantId, connectorId, updatedAt, value, now),
    }),
    clearConnectorCredential: ({ tenantId, connectorId, updatedAt, now }) => ({
      written: this.clearConnectorCredential(tenantId, connectorId, updatedAt, now),
    }),
    startConnectorAuthorization: async ({
      tenantId,
      principalId,
      connectorId,
      updatedAt,
      controlPlaneOrigin,
      now,
    }) => ({
      started: await this.startConnectorAuthorization(
        tenantId,
        principalId,
        connectorId,
        updatedAt,
        controlPlaneOrigin,
        now,
      ),
    }),
    connectorCallback: async ({ claims, stateHash, callback, initiatorIsOwner, now }) => ({
      settled: await this.connectorCallback(claims, stateHash, callback, initiatorIsOwner, now),
    }),
    serveConnectorToken: async ({ turnId, connectorId, now }) => ({
      served: await this.serveConnectorToken(turnId, connectorId, now),
    }),
    unknownConnectors: ({ connectorIds }) => ({ unknownConnectorIds: this.unknownConnectors(connectorIds) }),
    startOpenRouterAuthorization: async ({ tenantId, principalId, input, now }) => ({
      started: await this.startOpenRouterAuthorization(tenantId, principalId, input, now),
    }),
    getOpenRouterAuthorization: ({ tenantId, principalId, openRouterAuthorizationId }) => ({
      read: this.getOpenRouterAuthorization(tenantId, principalId, openRouterAuthorizationId),
    }),
    openRouterCallback: async ({ tenantId, openRouterAuthorizationId, callback, now }) => ({
      settled: await this.openRouterCallback(tenantId, openRouterAuthorizationId, callback, now),
    }),
    openRouterAuthorizationDeadlineReached: ({ deadline }) => {
      this.openRouterAuthorizationDeadlineReached(deadline);
      return {};
    },
    openRouterSecretSets: () => ({ names: this.openRouterSecretSets() }),
    startCircleCIAuthorization: async ({ tenantId, principalId, now }) => ({
      started: await this.startCircleCIAuthorization(tenantId, principalId, now),
    }),
    completeCircleCIAuthorization: async ({ tenantId, principalId, circleCIAuthorizationId, redirectedUrl, now }) => ({
      stepped: await this.completeCircleCIAuthorization(
        tenantId,
        principalId,
        circleCIAuthorizationId,
        redirectedUrl,
        now,
      ),
    }),
    chooseCircleCIOrganization: async ({ tenantId, principalId, circleCIAuthorizationId, organizationId, now }) => ({
      stepped: await this.chooseCircleCIOrganization(
        tenantId,
        principalId,
        circleCIAuthorizationId,
        organizationId,
        now,
      ),
    }),
    circleCIAuthorizationDeadlineReached: async ({ tenantId, deadline }) => {
      await this.circleCIAuthorizationDeadlineReached(tenantId, deadline);
      return {};
    },
    startClaudeSetup: async ({ tenantId, input, now }) => ({
      started: await this.startClaudeSetup(tenantId, input, now),
    }),
    getClaudeSetup: async ({ tenantId, claudeSetupId, now }) => ({
      setup: await this.getClaudeSetup(tenantId, claudeSetupId, now),
    }),
    listClaudeSetups: async ({ tenantId, secretSetId, now }) => ({
      setups: await this.listClaudeSetups(tenantId, secretSetId, now),
    }),
    submitClaudeSetupCode: async ({ tenantId, claudeSetupId, code, now }) => ({
      coded: await this.submitClaudeSetupCode(tenantId, claudeSetupId, code, now),
    }),
    writeClaudeSetupToken: async ({ tenantId, claudeSetupId, credential, token, tokenExpiresAt, now }) => ({
      stored: await this.writeClaudeSetupToken(tenantId, claudeSetupId, credential, token, tokenExpiresAt, now),
    }),
    claudeSetupDeadlineReached: async ({ tenantId, deadline }) => {
      await this.claudeSetupDeadlineReached(tenantId, deadline);
      return {};
    },
    prepareClaudeSetup: async ({ tenantId, stored, hostId, now }) => ({
      prepared: await this.prepareClaudeSetup(tenantId, stored, hostId, now),
    }),
  };

  protected supervisorUpdate(hostId: string, message: SupervisorUpdateMessage): void {
    recordSupervisorUpdate(this.ctx.storage.sql, hostId, message);
  }

  protected supervisorUpdates(hostIds: string[]): Record<string, SupervisorUpdates> {
    return supervisorUpdatesByHost(this.ctx.storage.sql, hostIds);
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

  protected open(tenantId: string, now: number): void {
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
        "INSERT INTO personas (persona_id, tenant_id, name, harness, secret_set_id, box_memory_mib, box_disk_mib, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        tenantId,
        DEFAULT_PERSONA.name,
        DEFAULT_PERSONA.harness,
        secretSetId,
        BoxMemoryLimit.DefaultMib,
        BoxDiskLimit.DefaultMib,
        now,
        now,
      );
    });
  }

  private persona(row: PersonaRow): StoredPersona {
    const sql = this.ctx.storage.sql;
    const connectorIds = sql
      .exec<{ connector_id: string }>(
        "SELECT connector_id FROM persona_connectors WHERE persona_id = ? ORDER BY rowid",
        row.persona_id,
      )
      .toArray()
      .map((each) => each.connector_id);
    return toPersona(row, personaFileRows(sql, row.persona_id), connectorIds);
  }

  protected listPersonas(tenantId: string): StoredPersona[] {
    return this.ctx.storage.sql
      .exec<PersonaRow>(`${PERSONA_SELECT} WHERE tenant_id = ? ORDER BY created_at, persona_id`, tenantId)
      .toArray()
      .map((row) => this.persona(row));
  }

  protected getPersona(tenantId: string, personaId: string): StoredPersona | null {
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

  private writeConnectors(personaId: string, connectorIds: readonly string[]): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM persona_connectors WHERE persona_id = ?", personaId);
    for (const connectorId of connectorIds) {
      sql.exec("INSERT INTO persona_connectors (persona_id, connector_id) VALUES (?, ?)", personaId, connectorId);
    }
  }

  protected createPersona(tenantId: string, persona: PersonaWrite, now: number): Written<StoredPersona> {
    const personaId = crypto.randomUUID();
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO personas (persona_id, tenant_id, name, harness, secret_set_id, box_memory_mib, box_disk_mib, box_retention, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          personaId,
          tenantId,
          persona.name,
          persona.harness,
          persona.secretSetId,
          persona.boxMemoryMib,
          persona.boxDiskMib,
          persona.boxRetention,
          now,
          now,
        );
        this.writeFiles(personaId, persona.files, now);
        this.writeConnectors(personaId, persona.connectorIds);
      }),
    );
    if (!written.ok) return written;
    const created = this.getPersona(tenantId, personaId);
    if (created === null) throw new Error(`persona ${personaId} was created and then not found`);
    return { ok: true, value: created };
  }

  protected updatePersona(
    tenantId: string,
    personaId: string,
    persona: PersonaChange,
    now: number,
  ): Written<StoredPersona | null> {
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        const updated = this.ctx.storage.sql.exec(
          "UPDATE personas SET name = ?, secret_set_id = ?, box_memory_mib = ?, box_disk_mib = ?, box_retention = ?, updated_at = ? WHERE tenant_id = ? AND persona_id = ?",
          persona.name,
          persona.secretSetId,
          persona.boxMemoryMib,
          persona.boxDiskMib,
          persona.boxRetention,
          now,
          tenantId,
          personaId,
        );
        if (updated.rowsWritten === 0) return false;
        this.writeFiles(personaId, persona.files, now);
        this.writeConnectors(personaId, persona.connectorIds);
        return true;
      }),
    );
    if (!written.ok) return written;
    return { ok: true, value: written.value ? this.getPersona(tenantId, personaId) : null };
  }

  protected deletePersona(tenantId: string, personaId: string): PersonaDeleted {
    const sql = this.ctx.storage.sql;
    const sessions = sql
      .exec<{ session_id: string }>(
        "SELECT session_id FROM sessions WHERE persona_id = ? AND state NOT IN ('Failed', 'Archived') ORDER BY created_at, session_id",
        personaId,
      )
      .toArray()
      .map((row) => row.session_id);
    if (sessions.length > 0) return { kind: "InUse", sessions };
    const deleted =
      sql.exec("DELETE FROM personas WHERE tenant_id = ? AND persona_id = ?", tenantId, personaId).rowsWritten > 0;
    return deleted ? { kind: "Deleted" } : { kind: "NotFound" };
  }

  private secretSetsWhere(tenantId: string, where: string, ...bindings: string[]): SecretSetsRead {
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec<SecretSetRow>(
        `SELECT secret_set_id, name, created_at, updated_at FROM secret_sets${where} ORDER BY created_at, secret_set_id`,
        ...bindings,
      )
      .toArray();
    const secretSets: SecretSet[] = [];
    for (const row of rows) {
      const stored = storedKeys(memberRows(sql, row.secret_set_id));
      if (stored.kind === "Unreadable") {
        return {
          kind: "Unreadable",
          secretSetId: row.secret_set_id,
          name: row.name,
          member: stored.name,
          detail: stored.detail,
        };
      }
      secretSets.push(
        SecretSetSchema.parse({
          secretSetId: row.secret_set_id,
          tenantId,
          name: row.name,
          keys: stored.keys,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      );
    }
    return { kind: "Read", secretSets };
  }

  protected listSecretSets(tenantId: string): SecretSetsRead {
    return this.secretSetsWhere(tenantId, "");
  }

  protected getSecretSet(tenantId: string, secretSetId: string): SecretSetRead {
    const read = this.secretSetsWhere(tenantId, " WHERE secret_set_id = ?", secretSetId);
    if (read.kind === "Unreadable") return read;
    const [secretSet] = read.secretSets;
    return secretSet === undefined ? { kind: "NotFound" } : { kind: "Found", secretSet };
  }

  private rewrittenSecretSet(tenantId: string, secretSetId: string): SecretSet {
    const read = this.getSecretSet(tenantId, secretSetId);
    if (read.kind !== "Found") throw new Error(`secret set ${secretSetId} was written and then read back ${read.kind}`);
    return read.secretSet;
  }

  private async sealMembers(
    secretSetId: string,
    secrets: readonly SecretMember[],
    now: number,
  ): Promise<SealedMember[]> {
    if (secrets.length === 0) return [];
    const dataKey = await this.dataKey();
    const sealed: SealedMember[] = [];
    for (const member of secrets) {
      sealed.push({
        member,
        sealed: await seal(dataKey, member.value, sealContext(secretSetId, member.name)),
        updatedAt: now,
      });
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

  private writeMember(secretSetId: string, { member, sealed, updatedAt }: SealedMember): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT INTO secret_values (secret_set_id, name, kind, sealed, updated_at) VALUES (?, ?, ?, ?, ?)",
      secretSetId,
      member.name,
      member.kind,
      sealed,
      updatedAt,
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
    for (const member of secrets) this.writeMember(secretSetId, member);
  }

  protected async createSecretSet(
    tenantId: string,
    secretSet: SecretSetWrite,
    githubUser: GitHubUser | null,
    now: number,
  ): Promise<Written<SecretSet>> {
    const secretSetId = crypto.randomUUID();
    const sealed = await this.sealMembers(secretSetId, secretSet.secrets, now);
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
    return { ok: true, value: this.rewrittenSecretSet(tenantId, secretSetId) };
  }

  protected async updateSecretSet(
    tenantId: string,
    secretSetId: string,
    change: SecretSetChange,
    githubUser: GitHubUser | null,
    now: number,
  ): Promise<SecretSetUpdated> {
    if (!this.hasSecretSet(secretSetId)) return { kind: "SetNotFound" };
    const plan = planUpdate(memberRows(this.ctx.storage.sql, secretSetId), change.secrets);
    if (plan.kind !== "Planned") return plan;
    const dataKey = await this.dataKey();
    const sealed: SealedMember[] = [];
    for (const planned of plan.members) {
      if (planned.kind === "Written") {
        const { member } = planned;
        sealed.push({
          member,
          sealed: await seal(dataKey, member.value, sealContext(secretSetId, member.name)),
          updatedAt: now,
        });
        continue;
      }
      const { update, from } = planned;
      if (from.name === update.name) {
        sealed.push({ member: update, sealed: from.sealed, updatedAt: from.updated_at });
        continue;
      }
      const value = await unseal(dataKey, from.sealed, sealContext(secretSetId, from.name));
      const member = memberWith(update, value);
      sealed.push({
        member,
        sealed: await seal(dataKey, value, sealContext(secretSetId, member.name)),
        updatedAt: now,
      });
    }
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        const updated = sql.exec(
          "UPDATE secret_sets SET name = ?, updated_at = ? WHERE secret_set_id = ?",
          change.name,
          now,
          secretSetId,
        );
        if (updated.rowsWritten === 0) return false;
        sql.exec("DELETE FROM secret_values WHERE secret_set_id = ?", secretSetId);
        if (!plan.keepsGitHubUser) this.writeGitHubUser(secretSetId, githubUser, now);
        for (const member of sealed) this.writeMember(secretSetId, member);
        return true;
      }),
    );
    if (!written.ok) return { kind: "Conflict", constraint: written.constraint };
    if (!written.value) return { kind: "SetNotFound" };
    return { kind: "Updated", secretSet: this.rewrittenSecretSet(tenantId, secretSetId) };
  }

  protected async setSecretMember(
    tenantId: string,
    secretSetId: string,
    member: SecretMember,
    githubUser: GitHubUser | null,
    now: number,
  ): Promise<SecretMemberSet> {
    if (!this.hasSecretSet(secretSetId)) return { kind: "SetNotFound" };
    const sealed = await this.sealMembers(secretSetId, [member], now);
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        sql.exec("DELETE FROM secret_values WHERE secret_set_id = ? AND name = ?", secretSetId, member.name);
        for (const each of sealed) this.writeMember(secretSetId, each);
        if (member.name === REPOSITORY_TOKEN) this.writeGitHubUser(secretSetId, githubUser, now);
        sql.exec("UPDATE secret_sets SET updated_at = ? WHERE secret_set_id = ?", now, secretSetId);
      }),
    );
    if (!written.ok) return { kind: "Conflict", constraint: written.constraint };
    const read = this.getSecretSet(tenantId, secretSetId);
    if (read.kind === "Found") return { kind: "Set", secretSet: read.secretSet };
    return read.kind === "NotFound" ? { kind: "SetNotFound" } : read;
  }

  protected removeSecretMember(tenantId: string, secretSetId: string, name: string, now: number): SecretMemberRemoved {
    const sql = this.ctx.storage.sql;
    const removed = this.ctx.storage.transactionSync(() => {
      const deleted = sql.exec("DELETE FROM secret_values WHERE secret_set_id = ? AND name = ?", secretSetId, name);
      if (deleted.rowsWritten === 0) return false;
      if (name === REPOSITORY_TOKEN) this.writeGitHubUser(secretSetId, null, now);
      sql.exec("UPDATE secret_sets SET updated_at = ? WHERE secret_set_id = ?", now, secretSetId);
      return true;
    });
    const read = this.getSecretSet(tenantId, secretSetId);
    if (read.kind === "NotFound") return { kind: "SetNotFound" };
    if (read.kind === "Unreadable") return read;
    return removed ? { kind: "Removed", secretSet: read.secretSet } : { kind: "MemberNotFound" };
  }

  protected deleteSecretSet(secretSetId: string): SecretSetDeleted {
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

  private writeConfig(tenantId: string, write: ConfigWrite, sealed: Map<string, SealedMember[]>, now: number): void {
    const sql = this.ctx.storage.sql;
    switch (write.kind) {
      case "CreateSecretSet":
        sql.exec(
          "INSERT INTO secret_sets (secret_set_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          write.secretSetId,
          write.secretSet.name,
          now,
          now,
        );
        this.writeSecrets(write.secretSetId, sealedOf(sealed, write.secretSetId), write.githubUser, now);
        return;
      case "RewriteSecretSet": {
        sql.exec(
          "UPDATE secret_sets SET name = ?, updated_at = ? WHERE secret_set_id = ?",
          write.secretSet.name,
          now,
          write.secretSetId,
        );
        this.writeSecrets(write.secretSetId, sealedOf(sealed, write.secretSetId), write.githubUser, now);
        return;
      }
      case "DeleteSecretSet":
        sql.exec("DELETE FROM secret_sets WHERE secret_set_id = ?", write.secretSetId);
        return;
      case "CreatePersona": {
        const personaId = crypto.randomUUID();
        sql.exec(
          "INSERT INTO personas (persona_id, tenant_id, name, harness, secret_set_id, box_memory_mib, box_disk_mib, box_retention, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          personaId,
          tenantId,
          write.persona.name,
          write.persona.harness,
          write.persona.secretSetId,
          write.persona.boxMemoryMib,
          write.persona.boxDiskMib,
          write.persona.boxRetention,
          now,
          now,
        );
        this.writeFiles(personaId, write.persona.files, now);
        this.writeConnectors(personaId, write.persona.connectorIds);
        return;
      }
      case "UpdatePersona": {
        sql.exec(
          "UPDATE personas SET name = ?, secret_set_id = ?, box_memory_mib = ?, box_disk_mib = ?, box_retention = ?, updated_at = ? WHERE tenant_id = ? AND persona_id = ?",
          write.persona.name,
          write.persona.secretSetId,
          write.persona.boxMemoryMib,
          write.persona.boxDiskMib,
          write.persona.boxRetention,
          now,
          tenantId,
          write.personaId,
        );
        this.writeFiles(write.personaId, write.persona.files, now);
        this.writeConnectors(write.personaId, write.persona.connectorIds);
        return;
      }
      case "DeletePersona":
        sql.exec("DELETE FROM personas WHERE tenant_id = ? AND persona_id = ?", tenantId, write.personaId);
        return;
      case "Pin":
        this.pin(write.pin, now);
        return;
      case "Unpin":
        this.unpin(write.harness);
        return;
    }
  }

  private deletedDuringApply(tenantId: string, writes: ConfigWrite[]): string | null {
    const created = new Set(writes.flatMap((write) => (write.kind === "CreateSecretSet" ? [write.secretSetId] : [])));
    for (const write of writes) {
      const setId = write.kind === "CreatePersona" || write.kind === "UpdatePersona" ? write.persona.secretSetId : null;
      if (setId !== null && !created.has(setId) && !this.hasSecretSet(setId)) return `secret set ${setId}`;
      if (write.kind === "RewriteSecretSet" && !this.hasSecretSet(write.secretSetId)) {
        return `secret set ${write.secretSetId}`;
      }
      if (write.kind === "UpdatePersona" && this.getPersona(tenantId, write.personaId) === null) {
        return `persona ${write.personaId}`;
      }
    }
    return null;
  }

  protected async applyConfig(tenantId: string, writes: ConfigWrite[], now: number): Promise<ConfigApplied> {
    const sealed = new Map<string, SealedMember[]>();
    for (const write of writes) {
      if (write.kind !== "CreateSecretSet" && write.kind !== "RewriteSecretSet") continue;
      sealed.set(write.secretSetId, await this.sealMembers(write.secretSetId, write.secretSet.secrets, now));
    }
    const deleted = this.deletedDuringApply(tenantId, writes);
    if (deleted !== null) return { kind: "Deleted", resource: deleted };
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        for (const write of writes) this.writeConfig(tenantId, write, sealed, now);
      }),
    );
    return written.ok ? { kind: "Applied" } : { kind: "Conflict", constraint: written.constraint };
  }

  protected listPins(): HarnessPin[] {
    return this.ctx.storage.sql
      .exec<HarnessPinRow>("SELECT harness, harness_version, updated_at FROM harness_pins ORDER BY harness")
      .toArray()
      .map(toPin);
  }

  protected pin(pin: HarnessPinWrite, now: number): HarnessPin {
    this.ctx.storage.sql.exec(
      `INSERT INTO harness_pins (harness, harness_version, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (harness) DO UPDATE SET harness_version = excluded.harness_version, updated_at = excluded.updated_at`,
      pin.harness,
      pin.harnessVersion,
      now,
    );
    return { ...pin, updatedAt: now };
  }

  protected unpin(harness: string): boolean {
    return this.ctx.storage.sql.exec("DELETE FROM harness_pins WHERE harness = ?", harness).rowsWritten > 0;
  }
}
