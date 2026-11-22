import { PrebuildFailureSchema, PrebuildSchema } from "@tumpel/schemas";
import type { z } from "zod";
import { type GitHubRepository, type Permissions, REPOSITORY_TOKEN, repositoryCredential } from "./github.ts";
import type { ConfigSource } from "./prebuild-inputs.ts";
import { TenantPushSubscriptions } from "./tenant-push-subscriptions.ts";
import { type FailureReport, type NewSession, PREBUILD_ARCHITECTURE, type Started } from "./tenant-sessions";

export type Prebuild = z.infer<typeof PrebuildSchema>;
export type PrebuildFailure = z.infer<typeof PrebuildFailureSchema>;

export type ReadToken = { kind: "Token"; token: string } | { kind: "Refused"; detail: string };

export interface PrebuildKey {
  repository: string;
  inputDigest: string;
  guestImageDigest: string;
}

export interface PrebuildCommit {
  prebuildId: string;
  personaId: string;
  key: PrebuildKey;
  configSource: ConfigSource;
  defaultBranch: string;
  headSha: string;
  rootfsKey: string;
  logUrl: string;
}

type PrebuildRow = {
  prebuild_id: string;
  persona_id: string;
  repository: string;
  default_branch: string;
  input_digest: string;
  guest_image_digest: string;
  config_source: string;
  head_sha: string;
  rootfs_key: string;
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

const PREBUILD_SELECT = `SELECT prebuilds.prebuild_id, persona_id, repository, default_branch, input_digest, guest_image_digest, config_source,
  head_sha, rootfs_key, state, started_at, log_url, prebuilds.created_at, prebuilds.updated_at, prebuild_layers.layer_digest,
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
    configSource: row.config_source,
    status: statusOf(row),
    startedAt: row.started_at,
    logUrl: row.log_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class TenantPrebuilds extends TenantPushSubscriptions {
  protected listPrebuilds(tenantId: string, repository: string | null): Prebuild[] {
    return this.ctx.storage.sql
      .exec<PrebuildRow>(
        `${PREBUILD_SELECT} WHERE ?1 IS NULL OR repository = ?1 ORDER BY prebuilds.created_at DESC, prebuilds.rowid DESC`,
        repository,
      )
      .toArray()
      .map((row) => toPrebuild(tenantId, row));
  }

  protected listLatestPrebuilds(tenantId: string): Prebuild[] {
    return this.ctx.storage.sql
      .exec<PrebuildRow>(
        `${PREBUILD_SELECT} WHERE prebuilds.rowid IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER
        (PARTITION BY repository ORDER BY created_at DESC, rowid DESC) AS newness FROM prebuilds) WHERE newness = 1)
        ORDER BY repository`,
      )
      .toArray()
      .map((row) => toPrebuild(tenantId, row));
  }

  protected getPrebuild(tenantId: string, prebuildId: string): Prebuild | null {
    const [row] = this.ctx.storage.sql
      .exec<PrebuildRow>(`${PREBUILD_SELECT} WHERE prebuilds.prebuild_id = ?`, prebuildId)
      .toArray();
    return row === undefined ? null : toPrebuild(tenantId, row);
  }

  protected heldPrebuild(tenantId: string, key: PrebuildKey): Prebuild | null {
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

  private writePrebuildCommit(commit: PrebuildCommit, state: string, now: number): void {
    const { prebuildId } = commit;
    this.ctx.storage.sql.exec(
      `INSERT INTO prebuilds (prebuild_id, persona_id, repository, default_branch, input_digest, guest_image_digest,
        config_source, head_sha, rootfs_key, state, started_at, log_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      prebuildId,
      commit.personaId,
      commit.key.repository,
      commit.defaultBranch,
      commit.key.inputDigest,
      commit.key.guestImageDigest,
      commit.configSource,
      commit.headSha,
      commit.rootfsKey,
      state,
      new Date(now).toISOString(),
      commit.logUrl,
      now,
      now,
    );
  }

  protected async failPrebuild(
    prebuildId: string,
    from: readonly string[],
    report: FailureReport,
    logUrl: string,
    now: number,
  ): Promise<boolean> {
    const failed = this.ctx.storage.transactionSync(() => {
      const placeholders = from.map(() => "?").join(", ");
      const moved = this.ctx.storage.sql.exec(
        `UPDATE prebuilds SET state = 'Failed', updated_at = ?, log_url = ?
        WHERE prebuild_id = ? AND state IN (${placeholders})`,
        now,
        logUrl,
        prebuildId,
        ...from,
      ).rowsWritten;
      if (moved === 0) return false;
      this.appendEvent(
        { event: "PrebuildFailed", prebuildId, repository: this.prebuildRepository(prebuildId), phase: report.phase },
        now,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO prebuild_failures (prebuild_id, phase, detail, fix, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        prebuildId,
        report.phase,
        report.detail,
        report.fix,
        new Date(now).toISOString(),
        now,
      );
      return true;
    });
    return failed;
  }

  protected async startHostPrebuild(
    tenantId: string,
    commit: Omit<PrebuildCommit, "logUrl">,
    input: NewSession,
    apiOrigin: string,
    now: number,
  ): Promise<Started<Prebuild>> {
    const hosts = input.hosts.filter((host) => host.architecture === PREBUILD_ARCHITECTURE);
    const begun = await this.begin(tenantId, { ...input, hosts }, now, (sessionId) => {
      this.writePrebuildCommit(
        { ...commit, logUrl: `${apiOrigin}/v1/sessions/${sessionId}/transcript` },
        "Dispatched",
        now,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO prebuild_sessions (prebuild_id, session_id, created_at) VALUES (?, ?, ?)",
        commit.prebuildId,
        sessionId,
        now,
      );
    });
    if (begun.kind === "TagsOverLimit") {
      throw new Error(
        `prebuild ${commit.prebuildId} would carry ${begun.tags.length} tags, and a prebuild inherits none`,
      );
    }
    if (begun.kind !== "Started") return begun;
    return { kind: "Started", started: this.prebuildOf(tenantId, commit.prebuildId) };
  }

  private prebuildOf(tenantId: string, prebuildId: string): Prebuild {
    return toPrebuild(
      tenantId,
      this.ctx.storage.sql.exec<PrebuildRow>(`${PREBUILD_SELECT} WHERE prebuilds.prebuild_id = ?`, prebuildId).one(),
    );
  }

  protected getPrebuildFailure(tenantId: string, prebuildId: string): PrebuildFailure | null {
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

  protected async repositoryReadToken(
    tenantId: string,
    personaId: string,
    repository: GitHubRepository,
    now: number,
    permissions: Permissions,
  ): Promise<ReadToken> {
    const persona = this.personaRow(personaId);
    if (persona === null) throw new Error(`persona ${personaId} is gone; the start checked it a moment ago`);
    const variables = (await this.members(persona.secretSetId)).flatMap((member) =>
      member.kind === "Variable" ? [{ name: member.name, value: member.value }] : [],
    );
    const credential = repositoryCredential(
      variables,
      await this.repositoryToken(tenantId, repository, now, { kind: "Exact", permissions }),
    );
    if (credential.kind === "Refused") return credential;
    const token = credential.variables.find((variable) => variable.name === REPOSITORY_TOKEN)?.value;
    if (token === undefined) {
      return {
        kind: "Refused",
        detail: `no token reads ${repository.owner}/${repository.name}: the tenant has no GitHub App installation for it and the persona's secret set holds no ${REPOSITORY_TOKEN}; connect GitHub for ${repository.owner}, or add a ${REPOSITORY_TOKEN} that reads the repository to the persona's secret set`,
      };
    }
    return { kind: "Token", token };
  }
}
