import { PrebuildFailureSchema, PrebuildSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { TenantSessions } from "./tenant-sessions";

export type Prebuild = z.infer<typeof PrebuildSchema>;
export type PrebuildFailure = z.infer<typeof PrebuildFailureSchema>;

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
}
