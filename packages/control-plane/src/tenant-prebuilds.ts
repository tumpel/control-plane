import {
  type BuildProviderSchema,
  GitHubActionsConnectionSchema,
  type GitHubActionsConnectionStartSchema,
  type NamespaceConnectionStartSchema,
  PrebuildFailureSchema,
  PrebuildSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { type GitHubRepository, REPOSITORY_TOKEN, repositoryCredential } from "./github.ts";
import { TenantSessions } from "./tenant-sessions";

export type Prebuild = z.infer<typeof PrebuildSchema>;
export type PrebuildFailure = z.infer<typeof PrebuildFailureSchema>;
export type BuildProvider = z.infer<typeof BuildProviderSchema>;
export type GitHubActionsConnection = z.infer<typeof GitHubActionsConnectionSchema>;
export type GitHubActionsConnectionStart = z.infer<typeof GitHubActionsConnectionStartSchema>;
export type NamespaceConnectionStart = z.infer<typeof NamespaceConnectionStartSchema>;

export interface NamespaceRow {
  namespaceConnectionId: string;
  accountLabel: string;
  audience: string;
  createdAt: number;
  updatedAt: number;
}

export type ReadToken = { kind: "Token"; token: string } | { kind: "Refused"; detail: string };

export interface PrebuildKey {
  repository: string;
  inputDigest: string;
  guestImageDigest: string;
}

const CONNECTION_TABLES: Record<BuildProvider, string> = {
  GitHubActions: "github_actions_connections",
  Namespace: "namespace_connections",
};

type PrebuildRow = {
  prebuild_id: string;
  persona_id: string;
  repository: string;
  input_digest: string;
  guest_image_digest: string;
  provider: string;
  state: string;
  started_at: string;
  log_url: string;
  created_at: number;
  updated_at: number;
  layer_digest: string | null;
  layer_size_bytes: number | null;
  layer_finished_at: string | null;
  failure_phase: string | null;
  failure_finished_at: string | null;
};

type FailureRow = {
  prebuild_id: string;
  phase: string;
  detail: string;
  fix: string;
  created_at: number;
};

const PREBUILD_SELECT = `SELECT prebuilds.prebuild_id, persona_id, repository, input_digest, guest_image_digest, provider, state,
  started_at, log_url, prebuilds.created_at, prebuilds.updated_at, prebuild_layers.layer_digest,
  prebuild_layers.layer_size_bytes, prebuild_layers.finished_at AS layer_finished_at,
  prebuild_failures.phase AS failure_phase, prebuild_failures.finished_at AS failure_finished_at
  FROM prebuilds
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
  if (row.state === "Failed") {
    return { state: row.state, phase: row.failure_phase, finishedAt: row.failure_finished_at };
  }
  return { state: row.state };
};

const toPrebuild = (tenantId: string, row: PrebuildRow): Prebuild =>
  PrebuildSchema.parse({
    prebuildId: row.prebuild_id,
    tenantId,
    personaId: row.persona_id,
    repository: row.repository,
    inputDigest: row.input_digest,
    guestImageDigest: row.guest_image_digest,
    provider: row.provider,
    status: statusOf(row),
    startedAt: row.started_at,
    logUrl: row.log_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class TenantPrebuilds extends TenantSessions {
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

  heldPrebuild(tenantId: string, key: PrebuildKey): Prebuild | null {
    const [row] = this.ctx.storage.sql
      .exec<PrebuildRow>(
        `${PREBUILD_SELECT} WHERE repository = ? AND input_digest = ? AND guest_image_digest = ? AND state != 'Failed'
        ORDER BY prebuilds.created_at DESC, prebuilds.rowid DESC LIMIT 1`,
        key.repository,
        key.inputDigest,
        key.guestImageDigest,
      )
      .toArray();
    return row === undefined ? null : toPrebuild(tenantId, row);
  }

  getPrebuildFailure(tenantId: string, prebuildId: string): PrebuildFailure | null {
    const [row] = this.ctx.storage.sql
      .exec<FailureRow>(
        "SELECT prebuild_id, phase, detail, fix, created_at FROM prebuild_failures WHERE prebuild_id = ?",
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
      createdAt: row.created_at,
    });
  }

  private connectionRow<T extends Record<string, SqlStorageValue>>(provider: BuildProvider): T | null {
    const [row] = this.ctx.storage.sql
      .exec<T>(`SELECT * FROM ${CONNECTION_TABLES[provider]} WHERE connection_slot = 1`)
      .toArray();
    return row ?? null;
  }

  connectedAccounts(): Record<BuildProvider, string | null> {
    const account = (provider: BuildProvider): string | null =>
      this.connectionRow<{ account_label: string }>(provider)?.account_label ?? null;
    return { GitHubActions: account("GitHubActions"), Namespace: account("Namespace") };
  }

  buildProviderConnected(provider: BuildProvider): boolean {
    return this.connectionRow(provider) !== null;
  }

  deleteBuildConnection(provider: BuildProvider): boolean {
    return this.ctx.storage.sql.exec(`DELETE FROM ${CONNECTION_TABLES[provider]}`).rowsWritten > 0;
  }

  gitHubActionsConnection(tenantId: string): GitHubActionsConnection | null {
    const row = this.connectionRow<{
      github_actions_connection_id: string;
      account_label: string;
      caller_workflow: string;
      created_at: number;
      updated_at: number;
    }>("GitHubActions");
    if (row === null) return null;
    return GitHubActionsConnectionSchema.parse({
      gitHubActionsConnectionId: row.github_actions_connection_id,
      tenantId,
      accountLabel: row.account_label,
      callerWorkflow: row.caller_workflow,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  connectGitHubActions(tenantId: string, start: GitHubActionsConnectionStart, now: number): GitHubActionsConnection {
    this.ctx.storage.sql.exec(
      `INSERT INTO github_actions_connections (connection_slot, github_actions_connection_id, account_label, caller_workflow, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (connection_slot) DO UPDATE SET account_label = excluded.account_label,
      caller_workflow = excluded.caller_workflow, updated_at = excluded.updated_at`,
      crypto.randomUUID(),
      start.accountLabel,
      start.callerWorkflow,
      now,
      now,
    );
    const connection = this.gitHubActionsConnection(tenantId);
    if (connection === null) throw new Error("the GitHub Actions connection was written and then not found");
    return connection;
  }

  namespaceConnection(): NamespaceRow | null {
    const row = this.connectionRow<{
      namespace_connection_id: string;
      account_label: string;
      audience: string;
      created_at: number;
      updated_at: number;
    }>("Namespace");
    if (row === null) return null;
    return {
      namespaceConnectionId: row.namespace_connection_id,
      accountLabel: row.account_label,
      audience: row.audience,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  connectNamespace(start: NamespaceConnectionStart, now: number): NamespaceRow {
    this.ctx.storage.sql.exec(
      `INSERT INTO namespace_connections (connection_slot, namespace_connection_id, account_label, audience, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (connection_slot) DO UPDATE SET account_label = excluded.account_label,
      audience = excluded.audience, updated_at = excluded.updated_at`,
      crypto.randomUUID(),
      start.accountLabel,
      start.audience,
      now,
      now,
    );
    const connection = this.namespaceConnection();
    if (connection === null) throw new Error("the Namespace connection was written and then not found");
    return connection;
  }

  async prebuildReadToken(
    tenantId: string,
    personaId: string,
    repository: GitHubRepository,
    now: number,
  ): Promise<ReadToken> {
    const persona = this.personaRow(personaId);
    if (persona === null) throw new Error(`persona ${personaId} is gone; the start checked it a moment ago`);
    const variables = (await this.members(persona.secretSetId)).flatMap((member) =>
      member.kind === "Variable" ? [{ name: member.name, value: member.value }] : [],
    );
    const url = `https://github.com/${repository.owner}/${repository.name}`;
    const credential = repositoryCredential(variables, await this.repositoryToken(tenantId, url, now));
    if (credential.kind === "Refused") return credential;
    const token = credential.variables.find((variable) => variable.name === REPOSITORY_TOKEN)?.value;
    if (token === undefined) {
      return {
        kind: "Refused",
        detail: `no token reads ${repository.owner}/${repository.name}: the tenant has no GitHub App installation for it and the persona's secret set holds no ${REPOSITORY_TOKEN}; install the GitHub App on ${repository.owner} with tumpel github start, or add a ${REPOSITORY_TOKEN} that reads the repository to the persona's secret set`,
      };
    }
    return { kind: "Token", token };
  }
}
