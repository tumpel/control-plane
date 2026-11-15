import {
  CiDispatchConnectionSchema,
  type CiDispatchConnectionStartSchema,
  EphemeralVmConnectionSchema,
  type EphemeralVmConnectionStartSchema,
  PrebuildFailureSchema,
  PrebuildSchema,
  type RemoteBuildKitConnectionStartSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { BUILD_PROVIDER_ORDER, type BuildProviderKind, type PrebuildFailurePhase } from "./build-provider.ts";
import { REPOSITORY_TOKEN, repositoryCredential } from "./github.ts";
import { TenantSessions } from "./tenant-sessions";

export type Prebuild = z.infer<typeof PrebuildSchema>;
export type PrebuildFailure = z.infer<typeof PrebuildFailureSchema>;
export type CiDispatchConnection = z.infer<typeof CiDispatchConnectionSchema>;
export type CiDispatchConnectionStart = z.infer<typeof CiDispatchConnectionStartSchema>;
export type EphemeralVmConnection = z.infer<typeof EphemeralVmConnectionSchema>;
export type EphemeralVmConnectionStart = z.infer<typeof EphemeralVmConnectionStartSchema>;
export type RemoteBuildKitConnectionStart = z.infer<typeof RemoteBuildKitConnectionStartSchema>;

export interface RemoteBuildKitRow {
  remoteBuildKitConnectionId: string;
  accountLabel: string;
  audience: string;
  createdAt: number;
  updatedAt: number;
}

export type ReadToken = { kind: "Token"; token: string | null } | { kind: "Refused"; detail: string };

export type Begun = { kind: "Held"; prebuild: Prebuild } | { kind: "Begun"; prebuild: Prebuild };

export interface PrebuildKey {
  personaId: string;
  repository: string;
  inputDigest: string;
  providerKind: BuildProviderKind;
  rebuild: boolean;
}

const CONNECTION_TABLES: Record<BuildProviderKind, string> = {
  CiDispatch: "ci_dispatch_connections",
  RemoteBuildKit: "remote_buildkit_connections",
  EphemeralVm: "ephemeral_vm_connections",
};

type PrebuildRow = {
  prebuild_id: string;
  persona_id: string;
  repository: string;
  input_digest: string;
  provider_kind: string;
  state: string;
  started_at: string;
  created_at: number;
  updated_at: number;
  log_url: string | null;
  layer_digest: string | null;
  layer_size_bytes: number | null;
  layer_finished_at: string | null;
  failure_phase: string | null;
  failed_at: string | null;
};

type FailureRow = {
  prebuild_id: string;
  phase: string;
  detail: string;
  fix: string;
  failed_at: string;
  created_at: number;
};

const PREBUILD_SELECT = `SELECT prebuilds.prebuild_id, persona_id, repository, input_digest, provider_kind, state, started_at,
  prebuilds.created_at, prebuilds.updated_at, prebuild_logs.log_url, prebuild_layers.layer_digest,
  prebuild_layers.layer_size_bytes, prebuild_layers.finished_at AS layer_finished_at,
  prebuild_failures.phase AS failure_phase, prebuild_failures.failed_at
  FROM prebuilds
  LEFT JOIN prebuild_logs USING (prebuild_id)
  LEFT JOIN prebuild_layers USING (prebuild_id)
  LEFT JOIN prebuild_failures USING (prebuild_id)`;

const statusOf = (row: PrebuildRow): unknown => {
  if (row.state === "Done") {
    return {
      state: row.state,
      layerDigest: row.layer_digest,
      layerSizeBytes: row.layer_size_bytes,
      finishedAt: row.layer_finished_at,
    };
  }
  if (row.state === "Failed") return { state: row.state, phase: row.failure_phase, finishedAt: row.failed_at };
  return { state: row.state };
};

const toPrebuild = (tenantId: string, row: PrebuildRow): Prebuild =>
  PrebuildSchema.parse({
    prebuildId: row.prebuild_id,
    tenantId,
    personaId: row.persona_id,
    repository: row.repository,
    inputDigest: row.input_digest,
    providerKind: row.provider_kind,
    status: statusOf(row),
    startedAt: row.started_at,
    logUrls: row.log_url === null ? [] : [row.log_url],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class TenantPrebuilds extends TenantSessions {
  hasPersona(personaId: string): boolean {
    return this.personaRow(personaId) !== null;
  }

  listPrebuilds(tenantId: string, repository: string): Prebuild[] {
    return this.ctx.storage.sql
      .exec<PrebuildRow>(
        `${PREBUILD_SELECT} WHERE repository = ? ORDER BY prebuilds.created_at DESC, prebuilds.rowid DESC`,
        repository,
      )
      .toArray()
      .map((row) => toPrebuild(tenantId, row));
  }

  getPrebuild(tenantId: string, prebuildId: string): Prebuild | null {
    const [row] = this.ctx.storage.sql
      .exec<PrebuildRow>(`${PREBUILD_SELECT} WHERE prebuilds.prebuild_id = ?`, prebuildId)
      .toArray();
    return row === undefined ? null : toPrebuild(tenantId, row);
  }

  getPrebuildFailure(tenantId: string, prebuildId: string): PrebuildFailure | null {
    const [row] = this.ctx.storage.sql
      .exec<FailureRow>(
        "SELECT prebuild_id, phase, detail, fix, failed_at, created_at FROM prebuild_failures WHERE prebuild_id = ?",
        prebuildId,
      )
      .toArray();
    if (row === undefined) return null;
    return PrebuildFailureSchema.parse({
      prebuildId: row.prebuild_id,
      tenantId,
      phase: row.phase,
      detail: row.detail,
      fix: row.fix,
      failedAt: row.failed_at,
      createdAt: row.created_at,
    });
  }

  private connectionRow<T extends Record<string, SqlStorageValue>>(kind: BuildProviderKind): T | null {
    const [row] = this.ctx.storage.sql
      .exec<T>(`SELECT * FROM ${CONNECTION_TABLES[kind]} WHERE connection_slot = 1`)
      .toArray();
    return row ?? null;
  }

  connectedAccounts(): Record<BuildProviderKind, string | null> {
    const account = (kind: BuildProviderKind): string | null =>
      this.connectionRow<{ account_label: string }>(kind)?.account_label ?? null;
    return {
      CiDispatch: account("CiDispatch"),
      RemoteBuildKit: account("RemoteBuildKit"),
      EphemeralVm: account("EphemeralVm"),
    };
  }

  connectedBuildProvider(): BuildProviderKind | null {
    return BUILD_PROVIDER_ORDER.find((kind) => this.connectionRow(kind) !== null) ?? null;
  }

  deleteBuildConnection(kind: BuildProviderKind): boolean {
    return this.ctx.storage.sql.exec(`DELETE FROM ${CONNECTION_TABLES[kind]}`).rowsWritten > 0;
  }

  ciDispatchConnection(tenantId: string): CiDispatchConnection | null {
    const row = this.connectionRow<{
      ci_dispatch_connection_id: string;
      account_label: string;
      caller_workflow: string;
      created_at: number;
      updated_at: number;
    }>("CiDispatch");
    if (row === null) return null;
    return CiDispatchConnectionSchema.parse({
      ciDispatchConnectionId: row.ci_dispatch_connection_id,
      tenantId,
      accountLabel: row.account_label,
      callerWorkflow: row.caller_workflow,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  connectCiDispatch(tenantId: string, start: CiDispatchConnectionStart, now: number): CiDispatchConnection {
    this.ctx.storage.sql.exec(
      `INSERT INTO ci_dispatch_connections (connection_slot, ci_dispatch_connection_id, account_label, caller_workflow, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (connection_slot) DO UPDATE SET account_label = excluded.account_label,
      caller_workflow = excluded.caller_workflow, updated_at = excluded.updated_at`,
      crypto.randomUUID(),
      start.accountLabel,
      start.callerWorkflow,
      now,
      now,
    );
    const connection = this.ciDispatchConnection(tenantId);
    if (connection === null) throw new Error("the CI dispatch connection was written and then not found");
    return connection;
  }

  remoteBuildKitConnection(): RemoteBuildKitRow | null {
    const row = this.connectionRow<{
      remote_buildkit_connection_id: string;
      account_label: string;
      audience: string;
      created_at: number;
      updated_at: number;
    }>("RemoteBuildKit");
    if (row === null) return null;
    return {
      remoteBuildKitConnectionId: row.remote_buildkit_connection_id,
      accountLabel: row.account_label,
      audience: row.audience,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  connectRemoteBuildKit(start: RemoteBuildKitConnectionStart, now: number): RemoteBuildKitRow {
    this.ctx.storage.sql.exec(
      `INSERT INTO remote_buildkit_connections (connection_slot, remote_buildkit_connection_id, account_label, audience, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (connection_slot) DO UPDATE SET account_label = excluded.account_label,
      audience = excluded.audience, updated_at = excluded.updated_at`,
      crypto.randomUUID(),
      start.accountLabel,
      start.audience,
      now,
      now,
    );
    const connection = this.remoteBuildKitConnection();
    if (connection === null) throw new Error("the remote BuildKit connection was written and then not found");
    return connection;
  }

  ephemeralVmConnection(tenantId: string): EphemeralVmConnection | null {
    const row = this.connectionRow<{
      ephemeral_vm_connection_id: string;
      account_label: string;
      host_label: string;
      created_at: number;
      updated_at: number;
    }>("EphemeralVm");
    if (row === null) return null;
    return EphemeralVmConnectionSchema.parse({
      ephemeralVmConnectionId: row.ephemeral_vm_connection_id,
      tenantId,
      accountLabel: row.account_label,
      hostLabel: row.host_label,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  connectEphemeralVm(tenantId: string, start: EphemeralVmConnectionStart, now: number): EphemeralVmConnection {
    this.ctx.storage.sql.exec(
      `INSERT INTO ephemeral_vm_connections (connection_slot, ephemeral_vm_connection_id, account_label, host_label, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (connection_slot) DO UPDATE SET account_label = excluded.account_label,
      host_label = excluded.host_label, updated_at = excluded.updated_at`,
      crypto.randomUUID(),
      start.accountLabel,
      start.hostLabel,
      now,
      now,
    );
    const connection = this.ephemeralVmConnection(tenantId);
    if (connection === null) throw new Error("the ephemeral VM connection was written and then not found");
    return connection;
  }

  async prebuildReadToken(tenantId: string, personaId: string, repository: string, now: number): Promise<ReadToken> {
    const persona = this.personaRow(personaId);
    if (persona === null) throw new Error(`persona ${personaId} is gone; the start checked it a moment ago`);
    const variables = (await this.members(persona.secretSetId)).flatMap((member) =>
      member.kind === "Variable" ? [{ name: member.name, value: member.value }] : [],
    );
    const credential = repositoryCredential(variables, await this.repositoryToken(tenantId, repository, now));
    if (credential.kind === "Refused") return credential;
    return {
      kind: "Token",
      token: credential.variables.find((variable) => variable.name === REPOSITORY_TOKEN)?.value ?? null,
    };
  }

  beginPrebuild(tenantId: string, key: PrebuildKey, now: number): Begun {
    const sql = this.ctx.storage.sql;
    if (!key.rebuild) {
      const [held] = sql
        .exec<{ prebuild_id: string }>(
          "SELECT prebuild_id FROM prebuilds WHERE repository = ? AND input_digest = ? AND state != 'Failed' ORDER BY created_at DESC, rowid DESC LIMIT 1",
          key.repository,
          key.inputDigest,
        )
        .toArray();
      const prebuild = held === undefined ? null : this.getPrebuild(tenantId, held.prebuild_id);
      if (prebuild !== null) return { kind: "Held", prebuild };
    }
    const prebuildId = crypto.randomUUID();
    sql.exec(
      "INSERT INTO prebuilds (prebuild_id, persona_id, repository, input_digest, provider_kind, state, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'Dispatched', ?, ?, ?)",
      prebuildId,
      key.personaId,
      key.repository,
      key.inputDigest,
      key.providerKind,
      new Date(now).toISOString(),
      now,
      now,
    );
    return { kind: "Begun", prebuild: this.prebuildOrThrow(tenantId, prebuildId) };
  }

  recordDispatch(tenantId: string, prebuildId: string, logUrl: string, now: number): Prebuild {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO prebuild_logs (prebuild_id, log_url, created_at) VALUES (?, ?, ?)",
        prebuildId,
        logUrl,
        now,
      );
      this.ctx.storage.sql.exec("UPDATE prebuilds SET updated_at = ? WHERE prebuild_id = ?", now, prebuildId);
    });
    return this.prebuildOrThrow(tenantId, prebuildId);
  }

  failPrebuild(
    tenantId: string,
    prebuildId: string,
    failure: { phase: PrebuildFailurePhase; detail: string; fix: string },
    now: number,
  ): Prebuild {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO prebuild_failures (prebuild_id, phase, detail, fix, failed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        prebuildId,
        failure.phase,
        failure.detail,
        failure.fix,
        new Date(now).toISOString(),
        now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE prebuilds SET state = 'Failed', updated_at = ? WHERE prebuild_id = ?",
        now,
        prebuildId,
      );
    });
    return this.prebuildOrThrow(tenantId, prebuildId);
  }

  private prebuildOrThrow(tenantId: string, prebuildId: string): Prebuild {
    const prebuild = this.getPrebuild(tenantId, prebuildId);
    if (prebuild === null) throw new Error(`prebuild ${prebuildId} was written and then not found`);
    return prebuild;
  }
}
