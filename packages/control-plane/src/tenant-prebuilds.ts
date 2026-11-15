import {
  type BuildProviderSchema,
  type CircleCIConnectionStartSchema,
  type CircleCIProjectAddSchema,
  CircleCIProjectSchema,
  GitHubActionsConnectionSchema,
  type GitHubActionsConnectionStartSchema,
  type NamespaceConnectionStartSchema,
  PrebuildFailureSchema,
  PrebuildSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import {
  CIRCLECI_WORKFLOW,
  type PipelineRun,
  pipelineLogUrl,
  readPipelineRevision,
  triggerPipeline,
  type WorkflowCompleted,
} from "./circleci.ts";
import { seal, unseal } from "./envelope.ts";
import {
  type GitHubAnswer,
  type GitHubRepository,
  type Minted,
  REPOSITORY_TOKEN,
  repositoryCredential,
} from "./github.ts";
import { type DispatchedRun, dispatchCallerWorkflow, type PrebuildInputs, type RunEvent } from "./github-actions.ts";
import type { DeadlineChanges, PrebuildDueDeadline } from "./session-timer";
import { settingsOf } from "./settings";
import { TenantSessions } from "./tenant-sessions";

export type Prebuild = z.infer<typeof PrebuildSchema>;
export type PrebuildFailure = z.infer<typeof PrebuildFailureSchema>;
export type BuildProvider = z.infer<typeof BuildProviderSchema>;
export type GitHubActionsConnection = z.infer<typeof GitHubActionsConnectionSchema>;
export type GitHubActionsConnectionStart = z.infer<typeof GitHubActionsConnectionStartSchema>;
export type NamespaceConnectionStart = z.infer<typeof NamespaceConnectionStartSchema>;
export type CircleCIConnectionStart = z.infer<typeof CircleCIConnectionStartSchema>;
export type CircleCIProject = z.infer<typeof CircleCIProjectSchema>;
export type CircleCIProjectAdd = z.infer<typeof CircleCIProjectAddSchema>;

export interface CircleCIRow {
  circleCIConnectionId: string;
  accountLabel: string;
  organizationId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CircleCIBinding {
  repository: string;
  projectSlug: string;
  projectId: string;
  pipelineDefinitionId: string;
  webhookId: string;
  signingSecret: string;
}

export interface CircleCIWebhook {
  circleCIProjectId: string;
  webhookId: string;
}

export type DispatchedCircleCI =
  | { kind: "Dispatched"; prebuild: Prebuild }
  | { kind: "NotConnected" }
  | { kind: "Refused"; detail: string };

type CircleCIProjectRow = {
  circleci_project_id: string;
  repository: string;
  project_slug: string;
  project_id: string;
  pipeline_definition_id: string;
  created_at: number;
  updated_at: number;
};

const CIRCLECI_TOKEN_CONTEXT = "circleci-connection/api_token";

const webhookSecretContext = (circleCIProjectId: string): string =>
  `circleci-projects/${circleCIProjectId}/signing_secret`;

const toCircleCIProject = (tenantId: string, row: CircleCIProjectRow): CircleCIProject =>
  CircleCIProjectSchema.parse({
    circleCIProjectId: row.circleci_project_id,
    tenantId,
    repository: row.repository,
    projectSlug: row.project_slug,
    projectId: row.project_id,
    pipelineDefinitionId: row.pipeline_definition_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export interface NamespaceRow {
  namespaceConnectionId: string;
  accountLabel: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
}

export type ReadToken = { kind: "Token"; token: string } | { kind: "Refused"; detail: string };

export interface PrebuildKey {
  repository: string;
  inputDigest: string;
  guestImageDigest: string;
}

export interface PrebuildRun {
  runId: number;
  headSha: string;
}

export interface PrebuildDispatch {
  prebuildId: string;
  personaId: string;
  key: PrebuildKey;
  defaultBranch: string;
  provider: BuildProvider;
  run: PrebuildRun;
  logUrl: string;
}

export type CallerWorkflow = { kind: "Connected"; callerWorkflow: string } | { kind: "NotConnected" };

export type RecordedRun = { kind: "Run"; run: PrebuildRun } | { kind: "NoRun" };

export type UploadJob = { kind: "Job"; jobId: string } | { kind: "NoJob" };

export interface RecordedPipeline {
  pipelineId: string;
  projectId: string;
  headSha: string;
  job: UploadJob;
}

export interface CircleCIUploadJob {
  pipelineId: string;
  headSha: string;
  jobId: string;
}

export type CircleCIJobBound =
  | { kind: "Bound" }
  | { kind: "OtherJob"; jobId: string }
  | { kind: "RevisionMoved"; prebuild: Prebuild }
  | { kind: "Refused"; status: number; detail: string };

export interface PrebuildStartRecord {
  prebuildId: string;
  personaId: string;
  key: PrebuildKey;
  target: GitHubRepository;
  defaultBranch: string;
  headSha: string;
  rootfsUrl: string;
  apiOrigin: string;
}

export type DispatchedPrebuild =
  | { kind: "Dispatched"; prebuild: Prebuild }
  | { kind: "NoInstallation" }
  | { kind: "Refused"; detail: string };

type PrebuildFailurePhase = PrebuildFailure["phase"];

interface FailureReport {
  phase: PrebuildFailurePhase;
  detail: string;
  fix: string;
}

export interface PrebuildLayerUpload {
  layerDigest: string;
  layerSizeBytes: number;
}

interface UploadTargetOf {
  prebuild: Prebuild;
  defaultBranch: string;
  upload: PrebuildLayerUpload | null;
}

export type GitHubActionsUploadTarget = UploadTargetOf & {
  provider: "GitHubActions";
  callerWorkflow: CallerWorkflow;
  run: PrebuildRun;
};

export type CircleCIUploadTarget = UploadTargetOf & {
  provider: "CircleCI";
  organizationId: string;
  pipeline: RecordedPipeline;
};

export type UploadTarget = GitHubActionsUploadTarget | CircleCIUploadTarget;

export type UploadRecorded =
  | { kind: "Recorded"; prebuild: Prebuild }
  | { kind: "NotUploading"; prebuild: Prebuild }
  | { kind: "OtherLayer"; prebuild: Prebuild; recorded: PrebuildLayerUpload };

const CONNECTION_TABLES: Record<BuildProvider, string> = {
  GitHubActions: "github_actions_connections",
  CircleCI: "circleci_connections",
  Namespace: "namespace_connections",
};

type PrebuildRow = {
  prebuild_id: string;
  persona_id: string;
  repository: string;
  default_branch: string;
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
  upload_layer_digest: string | null;
  upload_layer_size_bytes: number | null;
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

const PREBUILD_SELECT = `SELECT prebuilds.prebuild_id, persona_id, repository, default_branch, input_digest, guest_image_digest, provider, state,
  started_at, log_url, prebuilds.created_at, prebuilds.updated_at, prebuild_layers.layer_digest,
  prebuild_layers.layer_size_bytes, prebuild_layers.finished_at AS layer_finished_at,
  prebuild_failures.phase AS failure_phase, prebuild_failures.finished_at AS failure_finished_at,
  prebuild_uploads.layer_digest AS upload_layer_digest, prebuild_uploads.layer_size_bytes AS upload_layer_size_bytes
  FROM prebuilds
  LEFT JOIN prebuild_layers USING (prebuild_id)
  LEFT JOIN prebuild_uploads USING (prebuild_id)
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
  if (row.state === "Converting") {
    return {
      state: row.state,
      layerDigest: row.upload_layer_digest,
      layerSizeBytes: row.upload_layer_size_bytes,
      uploadedAt: new Date(row.updated_at).toISOString(),
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

  listLatestPrebuilds(tenantId: string): Prebuild[] {
    return this.ctx.storage.sql
      .exec<PrebuildRow>(
        `${PREBUILD_SELECT} WHERE prebuilds.rowid IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER
        (PARTITION BY repository ORDER BY created_at DESC, rowid DESC) AS newness FROM prebuilds) WHERE newness = 1)
        ORDER BY repository`,
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

  async recordDispatchedPrebuild(tenantId: string, dispatch: PrebuildDispatch, now: number): Promise<Prebuild> {
    this.writeDispatchedPrebuild(dispatch, now);
    return this.armDispatch(tenantId, dispatch.prebuildId, now);
  }

  private writeDispatchedPrebuild(dispatch: PrebuildDispatch, now: number): void {
    const { prebuildId } = dispatch;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO prebuilds (prebuild_id, persona_id, repository, default_branch, input_digest, guest_image_digest,
        provider, state, started_at, log_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'Dispatched', ?, ?, ?, ?)`,
        prebuildId,
        dispatch.personaId,
        dispatch.key.repository,
        dispatch.defaultBranch,
        dispatch.key.inputDigest,
        dispatch.key.guestImageDigest,
        dispatch.provider,
        new Date(now).toISOString(),
        dispatch.logUrl,
        now,
        now,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO prebuild_runs (prebuild_id, run_id, head_sha, created_at) VALUES (?, ?, ?, ?)",
        prebuildId,
        dispatch.run.runId,
        dispatch.run.headSha,
        now,
      );
    });
  }

  private async armDispatch(tenantId: string, prebuildId: string, now: number): Promise<Prebuild> {
    await this.prebuildTimers(tenantId, prebuildId, {
      PrebuildDispatch: { prebuildId, at: now + settingsOf(this.env).prebuildDispatchBudgetSeconds * 1000 },
    });
    const prebuild = this.getPrebuild(tenantId, prebuildId);
    if (prebuild === null) throw new Error(`prebuild ${prebuildId} was written and then not found`);
    return prebuild;
  }

  private recordedRun(prebuildId: string): RecordedRun {
    const [row] = this.ctx.storage.sql
      .exec<{ run_id: number; head_sha: string }>(
        "SELECT run_id, head_sha FROM prebuild_runs WHERE prebuild_id = ?",
        prebuildId,
      )
      .toArray();
    return row === undefined ? { kind: "NoRun" } : { kind: "Run", run: { runId: row.run_id, headSha: row.head_sha } };
  }

  private recordedPipeline(prebuildId: string): RecordedPipeline | null {
    const [row] = this.ctx.storage.sql
      .exec<{ pipeline_id: string; project_id: string; head_sha: string; job_id: string | null }>(
        `SELECT prebuild_pipelines.pipeline_id, prebuild_pipelines.project_id, prebuild_pipelines.head_sha,
        prebuild_upload_jobs.job_id FROM prebuild_pipelines LEFT JOIN prebuild_upload_jobs USING (prebuild_id)
        WHERE prebuild_pipelines.prebuild_id = ?`,
        prebuildId,
      )
      .toArray();
    if (row === undefined) return null;
    return {
      pipelineId: row.pipeline_id,
      projectId: row.project_id,
      headSha: row.head_sha,
      job: row.job_id === null ? { kind: "NoJob" } : { kind: "Job", jobId: row.job_id },
    };
  }

  private prebuildTimers(tenantId: string, prebuildId: string, changes: DeadlineChanges): Promise<void> {
    return this.env.SESSION_TIMER.getByName(prebuildId).set(tenantId, changes);
  }

  private async failPrebuild(
    tenantId: string,
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
    if (failed) await this.prebuildTimers(tenantId, prebuildId, { PrebuildDispatch: null, PrebuildBuild: null });
    return failed;
  }

  async recordPrebuildBuilding(tenantId: string, prebuildId: string, run: PrebuildRun, now: number): Promise<void> {
    const recorded = this.recordedRun(prebuildId);
    const prebuild = this.getPrebuild(tenantId, prebuildId);
    if (recorded.kind === "NoRun" || recorded.run.runId !== run.runId || prebuild?.status.state !== "Dispatched") {
      return;
    }
    if (recorded.run.headSha !== run.headSha) {
      await this.failPrebuild(
        tenantId,
        prebuildId,
        ["Dispatched"],
        {
          phase: "Dispatch",
          detail: `run ${run.runId} started on commit ${run.headSha}, and the start read the inputs of ${recorded.run.headSha}: the default branch moved between the start and the run`,
          fix: "Start the prebuild again, so it reads the inputs of the commit the run builds",
        },
        prebuild.logUrl,
        now,
      );
      return;
    }
    const moved = this.ctx.storage.sql.exec(
      "UPDATE prebuilds SET state = 'Building', updated_at = ? WHERE prebuild_id = ? AND state = 'Dispatched'",
      now,
      prebuildId,
    ).rowsWritten;
    if (moved === 0) return;
    await this.prebuildTimers(tenantId, prebuildId, {
      PrebuildDispatch: null,
      PrebuildBuild: { prebuildId, at: now + settingsOf(this.env).prebuildBuildBudgetSeconds * 1000 },
    });
  }

  async workflowRunReported(tenantId: string, event: RunEvent, now: number): Promise<void> {
    const [row] = this.ctx.storage.sql
      .exec<{ prebuild_id: string }>("SELECT prebuild_id FROM prebuild_runs WHERE run_id = ?", event.runId)
      .toArray();
    if (row === undefined) return;
    const prebuildId = row.prebuild_id;
    switch (event.action) {
      case "in_progress":
        await this.recordPrebuildBuilding(tenantId, prebuildId, { runId: event.runId, headSha: event.headSha }, now);
        return;
      case "completed":
        await this.failPrebuild(
          tenantId,
          prebuildId,
          ["Dispatched", "Building"],
          event.conclusion === "success"
            ? {
                phase: "Upload",
                detail: `run ${event.runId} succeeded and never completed the layer upload; its log is at ${event.htmlUrl}`,
                fix: "Call the reusable workflow from the caller workflow unchanged, so its upload job runs, then start the prebuild again with tumpel prebuild start --rebuild",
              }
            : {
                phase: "Build",
                detail: `run ${event.runId} ended ${event.conclusion ?? "without a conclusion"} before the layer upload completed; its log is at ${event.htmlUrl}`,
                fix: "Fix what the run's log names in the devcontainer or its lifecycle commands, then start the prebuild again with tumpel prebuild start --rebuild",
              },
          event.htmlUrl,
          now,
        );
    }
  }

  async prebuildDeadlineReached(tenantId: string, due: PrebuildDueDeadline): Promise<void> {
    const { prebuildId } = due.deadline;
    const prebuild = this.getPrebuild(tenantId, prebuildId);
    if (prebuild === null) return;
    const settings = settingsOf(this.env);
    const now = Date.now();
    if (due.name === "PrebuildDispatch") {
      await this.failPrebuild(
        tenantId,
        prebuildId,
        ["Dispatched"],
        {
          phase: "Dispatch",
          detail: `the run GitHub Actions accepted for prebuild ${prebuildId} did not start within prebuildDispatchBudgetSeconds ${settings.prebuildDispatchBudgetSeconds}; see ${prebuild.logUrl}`,
          fix: "Check that the repository's Actions are enabled and a runner is free, and that the GitHub App delivers workflow_run events, then start the prebuild again with tumpel prebuild start --rebuild",
        },
        prebuild.logUrl,
        now,
      );
      return;
    }
    const [upload] = this.ctx.storage.sql
      .exec("SELECT 1 FROM prebuild_uploads WHERE prebuild_id = ?", prebuildId)
      .toArray();
    await this.failPrebuild(
      tenantId,
      prebuildId,
      ["Building"],
      upload === undefined
        ? {
            phase: "Build",
            detail: `prebuild ${prebuildId} built for prebuildBuildBudgetSeconds ${settings.prebuildBuildBudgetSeconds} without starting its layer upload; see ${prebuild.logUrl}`,
            fix: "Make the devcontainer's lifecycle commands finish sooner, then start the prebuild again with tumpel prebuild start --rebuild",
          }
        : {
            phase: "Upload",
            detail: `prebuild ${prebuildId} started its layer upload and did not complete it within prebuildBuildBudgetSeconds ${settings.prebuildBuildBudgetSeconds}; see ${prebuild.logUrl}`,
            fix: "Keep the layer smaller or check the runner's bandwidth, then start the prebuild again with tumpel prebuild start --rebuild",
          },
      prebuild.logUrl,
      now,
    );
  }

  async dispatchPrebuild(
    tenantId: string,
    callerWorkflow: string,
    start: PrebuildStartRecord,
    now: number,
  ): Promise<DispatchedPrebuild> {
    const { prebuildId, target } = start;
    const minted: Minted = await this.repositoryToken(tenantId, target, now);
    if (minted.kind === "NoToken") return { kind: "NoInstallation" };
    if (minted.kind !== "Minted") return { kind: "Refused", detail: minted.detail };
    const inputs: PrebuildInputs = {
      prebuildId,
      tenantId,
      apiOrigin: start.apiOrigin,
      rootfsUrl: start.rootfsUrl,
      imageDigest: start.key.guestImageDigest,
    };
    const run = await this.ctx.blockConcurrencyWhile(async (): Promise<GitHubAnswer<DispatchedRun>> => {
      const answer = await dispatchCallerWorkflow(
        (url, init) => fetch(url, init),
        this.env.GITHUB_API_ORIGIN,
        minted.token,
        target,
        { callerWorkflow, ref: start.defaultBranch, inputs },
      );
      if (!answer.ok) return answer;
      this.writeDispatchedPrebuild(
        {
          prebuildId,
          personaId: start.personaId,
          key: start.key,
          defaultBranch: start.defaultBranch,
          provider: "GitHubActions",
          run: { runId: answer.value.runId, headSha: start.headSha },
          logUrl: answer.value.htmlUrl,
        },
        now,
      );
      return answer;
    });
    if (!run.ok) {
      return { kind: "Refused", detail: `${run.detail}, dispatching ${callerWorkflow} of ${start.key.repository}` };
    }
    return { kind: "Dispatched", prebuild: await this.armDispatch(tenantId, prebuildId, now) };
  }

  uploadTarget(tenantId: string, prebuildId: string): UploadTarget | null {
    const [row] = this.ctx.storage.sql
      .exec<PrebuildRow>(`${PREBUILD_SELECT} WHERE prebuilds.prebuild_id = ?`, prebuildId)
      .toArray();
    if (row === undefined) return null;
    const common = {
      prebuild: toPrebuild(tenantId, row),
      defaultBranch: row.default_branch,
      upload:
        row.upload_layer_digest === null || row.upload_layer_size_bytes === null
          ? null
          : { layerDigest: row.upload_layer_digest, layerSizeBytes: row.upload_layer_size_bytes },
    };
    if (row.provider === "GitHubActions") {
      const run = this.recordedRun(prebuildId);
      if (run.kind === "NoRun") return null;
      const connection = this.connectionRow<{ caller_workflow: string }>("GitHubActions");
      return {
        ...common,
        provider: "GitHubActions",
        callerWorkflow:
          connection === null
            ? { kind: "NotConnected" }
            : { kind: "Connected", callerWorkflow: connection.caller_workflow },
        run: run.run,
      };
    }
    if (row.provider !== "CircleCI") return null;
    const circleCI = this.connectionRow<{ organization_id: string }>("CircleCI");
    const pipeline = this.recordedPipeline(prebuildId);
    if (circleCI === null || pipeline === null) return null;
    return { ...common, provider: "CircleCI", organizationId: circleCI.organization_id, pipeline };
  }

  private prebuildOf(tenantId: string, prebuildId: string): Prebuild {
    return toPrebuild(
      tenantId,
      this.ctx.storage.sql.exec<PrebuildRow>(`${PREBUILD_SELECT} WHERE prebuilds.prebuild_id = ?`, prebuildId).one(),
    );
  }

  async bindCircleCIUploadJob(
    tenantId: string,
    prebuildId: string,
    upload: CircleCIUploadJob,
    now: number,
  ): Promise<CircleCIJobBound> {
    const token = await this.circleCIToken();
    if (token === null)
      throw new Error(`the CircleCI connection went away while prebuild ${prebuildId} took its upload`);
    const revision = await readPipelineRevision(
      (url, init) => fetch(url, init),
      this.env.CIRCLECI_API_ORIGIN,
      token,
      upload.pipelineId,
    );
    if (!revision.ok) return { kind: "Refused", status: revision.status, detail: revision.detail };
    if (revision.value !== upload.headSha)
      return this.failMovedRevision(tenantId, prebuildId, upload, revision.value, now);
    const [inserted] = this.ctx.storage.sql
      .exec<{ job_id: string }>(
        "INSERT INTO prebuild_upload_jobs (prebuild_id, job_id, created_at) VALUES (?, ?, ?) ON CONFLICT (prebuild_id) DO NOTHING RETURNING job_id",
        prebuildId,
        upload.jobId,
        now,
      )
      .toArray();
    if (inserted !== undefined) return { kind: "Bound" };
    const held = this.ctx.storage.sql
      .exec<{ job_id: string }>("SELECT job_id FROM prebuild_upload_jobs WHERE prebuild_id = ?", prebuildId)
      .one();
    return held.job_id === upload.jobId ? { kind: "Bound" } : { kind: "OtherJob", jobId: held.job_id };
  }

  private async failMovedRevision(
    tenantId: string,
    prebuildId: string,
    pipeline: { pipelineId: string; headSha: string },
    revision: string,
    now: number,
  ): Promise<CircleCIJobBound> {
    const prebuild = this.prebuildOf(tenantId, prebuildId);
    await this.failPrebuild(
      tenantId,
      prebuildId,
      ["Dispatched", "Building"],
      {
        phase: "Dispatch",
        detail: `pipeline ${pipeline.pipelineId} checked out commit ${revision}, and the start read the inputs of ${pipeline.headSha}: the default branch moved between the start and the pipeline`,
        fix: "Start the prebuild again, so it reads the inputs of the commit the pipeline builds",
      },
      prebuild.logUrl,
      now,
    );
    return { kind: "RevisionMoved", prebuild: this.prebuildOf(tenantId, prebuildId) };
  }

  startPrebuildUpload(tenantId: string, prebuildId: string, upload: PrebuildLayerUpload, now: number): UploadRecorded {
    const recorded = this.ctx.storage.transactionSync((): PrebuildLayerUpload | "Recorded" | "NotUploading" => {
      const [building] = this.ctx.storage.sql
        .exec("SELECT 1 FROM prebuilds WHERE prebuild_id = ? AND state = 'Building'", prebuildId)
        .toArray();
      if (building === undefined) return "NotUploading";
      const [held] = this.ctx.storage.sql
        .exec<{ layer_digest: string; layer_size_bytes: number }>(
          "SELECT layer_digest, layer_size_bytes FROM prebuild_uploads WHERE prebuild_id = ?",
          prebuildId,
        )
        .toArray();
      if (held !== undefined) {
        const same = held.layer_digest === upload.layerDigest && held.layer_size_bytes === upload.layerSizeBytes;
        return same ? "Recorded" : { layerDigest: held.layer_digest, layerSizeBytes: held.layer_size_bytes };
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO prebuild_uploads (prebuild_id, layer_digest, layer_size_bytes, created_at) VALUES (?, ?, ?, ?)",
        prebuildId,
        upload.layerDigest,
        upload.layerSizeBytes,
        now,
      );
      return "Recorded";
    });
    if (typeof recorded === "object") {
      const prebuild = this.getPrebuild(tenantId, prebuildId);
      if (prebuild === null) throw new Error(`prebuild ${prebuildId} is gone; the upload checked it a moment ago`);
      return { kind: "OtherLayer", prebuild, recorded };
    }
    return this.uploadRecorded(tenantId, prebuildId, recorded === "Recorded");
  }

  async completePrebuildUpload(
    tenantId: string,
    prebuildId: string,
    upload: PrebuildLayerUpload,
    now: number,
  ): Promise<UploadRecorded> {
    const moved = this.ctx.storage.sql.exec(
      `UPDATE prebuilds SET state = 'Converting', updated_at = ? WHERE prebuild_id = ? AND state = 'Building'
      AND EXISTS (SELECT 1 FROM prebuild_uploads WHERE prebuild_id = ? AND layer_digest = ? AND layer_size_bytes = ?)`,
      now,
      prebuildId,
      prebuildId,
      upload.layerDigest,
      upload.layerSizeBytes,
    ).rowsWritten;
    if (moved > 0) await this.prebuildTimers(tenantId, prebuildId, { PrebuildBuild: null });
    return this.uploadRecorded(tenantId, prebuildId, moved > 0);
  }

  private uploadRecorded(tenantId: string, prebuildId: string, recorded: boolean): UploadRecorded {
    const prebuild = this.getPrebuild(tenantId, prebuildId);
    if (prebuild === null) throw new Error(`prebuild ${prebuildId} is gone; the upload checked it a moment ago`);
    return recorded ? { kind: "Recorded", prebuild } : { kind: "NotUploading", prebuild };
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
    return {
      GitHubActions: account("GitHubActions"),
      CircleCI: account("CircleCI"),
      Namespace: account("Namespace"),
    };
  }

  buildProviderConnected(provider: BuildProvider): boolean {
    return this.connectionRow(provider) !== null;
  }

  deleteBuildConnection(provider: BuildProvider): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (provider === "CircleCI") this.ctx.storage.sql.exec("DELETE FROM circleci_projects");
      return this.ctx.storage.sql.exec(`DELETE FROM ${CONNECTION_TABLES[provider]}`).rowsWritten > 0;
    });
  }

  circleCIConnection(): CircleCIRow | null {
    const row = this.connectionRow<{
      circleci_connection_id: string;
      account_label: string;
      organization_id: string;
      created_at: number;
      updated_at: number;
    }>("CircleCI");
    if (row === null) return null;
    return {
      circleCIConnectionId: row.circleci_connection_id,
      accountLabel: row.account_label,
      organizationId: row.organization_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async circleCIToken(): Promise<string | null> {
    const row = this.connectionRow<{ api_token_sealed: string }>("CircleCI");
    if (row === null) return null;
    return unseal(
      await this.dataKey(),
      row.api_token_sealed,
      CIRCLECI_TOKEN_CONTEXT,
      "connect CircleCI again with tumpel circleci start --token-stdin",
    );
  }

  async connectCircleCI(start: CircleCIConnectionStart, now: number): Promise<CircleCIRow> {
    await this.holdDataKey();
    const sealed = await seal(await this.dataKey(), start.apiToken, CIRCLECI_TOKEN_CONTEXT);
    this.ctx.storage.sql.exec(
      `INSERT INTO circleci_connections (connection_slot, circleci_connection_id, account_label, organization_id, api_token_sealed,
      created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT (connection_slot) DO UPDATE SET
      account_label = excluded.account_label, organization_id = excluded.organization_id,
      api_token_sealed = excluded.api_token_sealed, updated_at = excluded.updated_at`,
      crypto.randomUUID(),
      start.accountLabel,
      start.organizationId,
      sealed,
      now,
      now,
    );
    const connection = this.circleCIConnection();
    if (connection === null) throw new Error("the CircleCI connection was written and then not found");
    return connection;
  }

  listCircleCIProjects(tenantId: string): CircleCIProject[] {
    return this.ctx.storage.sql
      .exec<CircleCIProjectRow>("SELECT * FROM circleci_projects ORDER BY repository")
      .toArray()
      .map((row) => toCircleCIProject(tenantId, row));
  }

  circleCIProjectOf(tenantId: string, repository: string): CircleCIProject | null {
    const [row] = this.ctx.storage.sql
      .exec<CircleCIProjectRow>("SELECT * FROM circleci_projects WHERE repository = ?", repository)
      .toArray();
    return row === undefined ? null : toCircleCIProject(tenantId, row);
  }

  async addCircleCIProject(tenantId: string, binding: CircleCIBinding, now: number): Promise<CircleCIProject> {
    const circleCIProjectId = crypto.randomUUID();
    await this.holdDataKey();
    const sealed = await seal(await this.dataKey(), binding.signingSecret, webhookSecretContext(circleCIProjectId));
    this.ctx.storage.sql.exec(
      `INSERT INTO circleci_projects (circleci_project_id, repository, project_slug, project_id, pipeline_definition_id,
      webhook_id, signing_secret_sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      circleCIProjectId,
      binding.repository,
      binding.projectSlug,
      binding.projectId,
      binding.pipelineDefinitionId,
      binding.webhookId,
      sealed,
      now,
      now,
    );
    const project = this.circleCIProjectOf(tenantId, binding.repository);
    if (project === null)
      throw new Error(`the CircleCI binding of ${binding.repository} was written and then not found`);
    return project;
  }

  circleCIWebhooks(): CircleCIWebhook[] {
    return this.ctx.storage.sql
      .exec<{ circleci_project_id: string; webhook_id: string }>(
        "SELECT circleci_project_id, webhook_id FROM circleci_projects ORDER BY repository",
      )
      .toArray()
      .map((row) => ({ circleCIProjectId: row.circleci_project_id, webhookId: row.webhook_id }));
  }

  async circleCIWebhookSecret(projectId: string): Promise<string | null> {
    const [row] = this.ctx.storage.sql
      .exec<{ circleci_project_id: string; signing_secret_sealed: string }>(
        "SELECT circleci_project_id, signing_secret_sealed FROM circleci_projects WHERE project_id = ?",
        projectId,
      )
      .toArray();
    if (row === undefined) return null;
    return unseal(
      await this.dataKey(),
      row.signing_secret_sealed,
      webhookSecretContext(row.circleci_project_id),
      "delete the CircleCI project binding and add it again",
    );
  }

  async dispatchCircleCIPrebuild(
    tenantId: string,
    start: PrebuildStartRecord,
    project: CircleCIProject,
    parameters: Record<string, string>,
    now: number,
  ): Promise<DispatchedCircleCI> {
    const token = await this.circleCIToken();
    if (token === null) return { kind: "NotConnected" };
    const { prebuildId } = start;
    const run = await this.ctx.blockConcurrencyWhile(async (): Promise<PipelineRun> => {
      const answer = await triggerPipeline((url, init) => fetch(url, init), this.env.CIRCLECI_API_ORIGIN, token, {
        projectSlug: project.projectSlug,
        definitionId: project.pipelineDefinitionId,
        branch: start.defaultBranch,
        parameters,
      });
      if (answer.kind !== "Created") return answer;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `INSERT INTO prebuilds (prebuild_id, persona_id, repository, default_branch, input_digest, guest_image_digest,
          provider, state, started_at, log_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'CircleCI', 'Building', ?, ?, ?, ?)`,
          prebuildId,
          start.personaId,
          start.key.repository,
          start.defaultBranch,
          start.key.inputDigest,
          start.key.guestImageDigest,
          new Date(now).toISOString(),
          pipelineLogUrl(project.projectSlug, answer.number),
          now,
          now,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO prebuild_pipelines (prebuild_id, pipeline_id, circleci_project_id, project_id, head_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          prebuildId,
          answer.pipelineId,
          project.circleCIProjectId,
          project.projectId,
          start.headSha,
          now,
        );
      });
      return answer;
    });
    if (run.kind === "Refused") {
      const reconnect =
        run.status === 401 || run.status === 403
          ? "; the token is expired or revoked, so connect again with tumpel circleci start --token-stdin"
          : "";
      return {
        kind: "Refused",
        detail: `${run.detail}, running pipeline definition ${project.pipelineDefinitionId} of ${project.projectSlug}${reconnect}`,
      };
    }
    await this.prebuildTimers(tenantId, prebuildId, {
      PrebuildBuild: { prebuildId, at: now + settingsOf(this.env).prebuildBuildBudgetSeconds * 1000 },
    });
    const prebuild = this.getPrebuild(tenantId, prebuildId);
    if (prebuild === null) throw new Error(`prebuild ${prebuildId} was written and then not found`);
    return { kind: "Dispatched", prebuild };
  }

  async circleCIWorkflowCompleted(tenantId: string, event: WorkflowCompleted, now: number): Promise<void> {
    if (event.type !== "workflow-completed" || event.workflow.name !== CIRCLECI_WORKFLOW) return;
    const [row] = this.ctx.storage.sql
      .exec<{ prebuild_id: string }>(
        "SELECT prebuild_id FROM prebuild_pipelines WHERE pipeline_id = ?",
        event.pipeline.id,
      )
      .toArray();
    if (row === undefined) return;
    const { status, url } = event.workflow;
    await this.failPrebuild(
      tenantId,
      row.prebuild_id,
      ["Dispatched", "Building"],
      status === "success"
        ? {
            phase: "Upload",
            detail: `workflow ${CIRCLECI_WORKFLOW} of pipeline ${event.pipeline.id} succeeded and never completed the layer upload; its log is at ${url}`,
            fix: "Keep the orb's upload job in the workflow, requiring the build job, then start the prebuild again with tumpel prebuild start --rebuild",
          }
        : {
            phase: "Build",
            detail: `workflow ${CIRCLECI_WORKFLOW} of pipeline ${event.pipeline.id} ended ${status} before the layer upload completed; its log is at ${url}`,
            fix: "Fix what the workflow's log names in the devcontainer, its lifecycle commands or the CircleCI config, then start the prebuild again with tumpel prebuild start --rebuild",
          },
      url,
      now,
    );
  }

  deleteCircleCIProject(circleCIProjectId: string): boolean {
    return (
      this.ctx.storage.sql.exec("DELETE FROM circleci_projects WHERE circleci_project_id = ?", circleCIProjectId)
        .rowsWritten > 0
    );
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
      workspace_id: string;
      created_at: number;
      updated_at: number;
    }>("Namespace");
    if (row === null) return null;
    return {
      namespaceConnectionId: row.namespace_connection_id,
      accountLabel: row.account_label,
      workspaceId: row.workspace_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  connectNamespace(start: NamespaceConnectionStart, now: number): NamespaceRow {
    this.ctx.storage.sql.exec(
      `INSERT INTO namespace_connections (connection_slot, namespace_connection_id, account_label, workspace_id, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (connection_slot) DO UPDATE SET account_label = excluded.account_label,
      workspace_id = excluded.workspace_id, updated_at = excluded.updated_at`,
      crypto.randomUUID(),
      start.accountLabel,
      start.workspaceId,
      now,
      now,
    );
    const connection = this.namespaceConnection();
    if (connection === null) throw new Error("the Namespace connection was written and then not found");
    return connection;
  }

  async repositoryReadToken(
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
    const credential = repositoryCredential(variables, await this.repositoryToken(tenantId, repository, now));
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
