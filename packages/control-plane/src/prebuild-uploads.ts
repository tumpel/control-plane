import {
  PrebuildPathSchema,
  PrebuildUploadCompleteSchema,
  PrebuildUploadGrantSchema,
  PrebuildUploadStartSchema,
} from "@tumpel/api/schemas";
import { circleCIRefused } from "./circleci-projects.ts";
import { REUSABLE_WORKFLOW, REUSABLE_WORKFLOW_PATH, REUSABLE_WORKFLOW_TAGS } from "./github-actions";
import { json, parseBody, problem } from "./http";
import type { Env } from "./index";
import { jwtVerifier, unverifiedIssuer, type VerifyJwt } from "./jwt";
import { signerOf } from "./presign";
import { settingsOf } from "./settings";
import type { Prebuild, PrebuildLayerUpload, UploadTarget } from "./tenant-prebuilds";

type Bound = { ok: true; tenantId: string; target: UploadTarget } | { ok: false; response: Response };

type JobIssuer = { provider: "GitHubActions" } | { provider: "CircleCI"; issuer: string; organizationId: string };

type JobClaims = { issuer: JobIssuer; claims: Record<string, unknown> };

const UPLOADS_PATH = /^\/v1\/prebuilds\/([^/]+)\/uploads(\/complete)?$/;
const DISPATCH_EVENT = "workflow_dispatch";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CIRCLECI_CLAIM = "oidc.circleci.com";

export const prebuildLayerKey = (tenantId: string, prebuildId: string, digest: string): string =>
  `${tenantId}/prebuilds/${prebuildId}/layers/${digest}`;

let jobVerifier: { key: string; verify: VerifyJwt } | undefined;

const verifierFor = (env: Env, audience: string): VerifyJwt => {
  const issuer = settingsOf(env).gitHubActionsIssuer.replace(/\/+$/, "");
  const key = `${issuer} ${audience}`;
  if (jobVerifier?.key === key) return jobVerifier.verify;
  jobVerifier = { key, verify: jwtVerifier(`${issuer}/.well-known/jwks`, issuer, audience) };
  return jobVerifier.verify;
};

const circleCIVerifiers = new Map<string, VerifyJwt>();

const circleCIVerifierFor = (issuer: string, audience: string): VerifyJwt => {
  const key = `${issuer} ${audience}`;
  const held = circleCIVerifiers.get(key);
  if (held !== undefined) return held;
  const verify = jwtVerifier(`${issuer}/.well-known/jwks-pub.json`, issuer, audience);
  circleCIVerifiers.set(key, verify);
  return verify;
};

const jobIssuerOf = (env: Env, token: string): JobIssuer => {
  const issuer = unverifiedIssuer(token);
  const prefix = `${env.CIRCLECI_OIDC_ORIGIN.replace(/\/+$/, "")}/org/`;
  if (issuer === null || !issuer.startsWith(prefix)) return { provider: "GitHubActions" };
  const organizationId = issuer.slice(prefix.length);
  if (!UUID.test(organizationId)) return { provider: "GitHubActions" };
  return { provider: "CircleCI", issuer, organizationId };
};

const tokenRefused = (check: string, detail: string, audience: string): Response =>
  problem(
    401,
    {
      code: "JobTokenRefused",
      title: `Job token refused: ${check}`,
      detail,
      fix: `Present the upload job's OIDC token for ${audience} as Authorization: Bearer <token> within its lifetime: on GitHub Actions request it with core.getIDToken('${audience}') in a job that holds permissions id-token: write, on CircleCI mint it with circleci run oidc get --aud ${audience}`,
    },
    { "www-authenticate": "Bearer" },
  );

const tokenMismatch = (check: string, detail: string, fix: string): Response =>
  problem(403, { code: "JobTokenMismatch", title: `Job token refused: ${check}`, detail, fix });

const notFound = (): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such prebuild",
    detail: "no prebuild of this id takes an upload from this job token",
    fix: "Pass the tenantId and prebuildId the dispatch handed the job, from a run in the prebuild's repository",
  });

const notUploading = (prebuild: Prebuild): Response =>
  problem(409, {
    code: "PrebuildNotUploading",
    title: "Prebuild not uploading",
    detail: `prebuild ${prebuild.prebuildId} is ${prebuild.status.state}, and only a Dispatched or Building prebuild takes its layer`,
    fix: `Upload from the run the prebuild dispatched once it runs, or start a new prebuild with tumpel prebuild start --rebuild; read this one with tumpel prebuild get ${prebuild.prebuildId}`,
  });

const claimOf = (claims: Record<string, unknown>, name: string): string | null => {
  const value = claims[name];
  return typeof value === "string" ? value : null;
};

const isReusableWorkflow = (jobWorkflow: string | null): boolean => {
  const prefix = `${REUSABLE_WORKFLOW_PATH}@refs/tags/`;
  if (jobWorkflow === null || !jobWorkflow.startsWith(prefix)) return false;
  const tag = jobWorkflow.slice(prefix.length);
  return REUSABLE_WORKFLOW_TAGS.test(tag);
};

const bindClaims = (target: UploadTarget, claims: Record<string, unknown>, repository: string): Response | null => {
  const { prebuild, defaultBranch, callerWorkflow, run } = target;
  if (prebuild.provider !== "GitHubActions") {
    return tokenMismatch(
      "provider",
      `prebuild ${prebuild.prebuildId} runs on ${prebuild.provider}, and a GitHub Actions job token uploads only the layer of a GitHub Actions prebuild`,
      "Upload the layer from the run the prebuild dispatched, with that provider's job token",
    );
  }
  if (callerWorkflow.kind === "NotConnected") {
    return tokenMismatch(
      "connection",
      "the tenant has no GitHub Actions connection",
      "Reconnect GitHub Actions with tumpel github-actions start, then start the prebuild again",
    );
  }
  const ref = claimOf(claims, "ref");
  const expectedRef = `refs/heads/${defaultBranch}`;
  if (ref !== expectedRef) {
    return tokenMismatch(
      "ref",
      `the token comes from a run on ${ref ?? "(none)"}, and prebuild ${prebuild.prebuildId} builds ${expectedRef}`,
      "Upload only from the run the prebuild dispatched on the repository's default branch",
    );
  }
  const event = claimOf(claims, "event_name");
  if (event !== DISPATCH_EVENT) {
    return tokenMismatch(
      "event_name",
      `the token comes from a run triggered by ${event ?? "(none)"}, and a prebuild runs only on ${DISPATCH_EVENT}`,
      "Upload only from the run the prebuild dispatched",
    );
  }
  const workflow = claimOf(claims, "workflow_ref");
  const expected = `${repository}/${callerWorkflow.callerWorkflow}@${expectedRef}`;
  if (workflow !== expected) {
    return tokenMismatch(
      "workflow_ref",
      `the token comes from workflow ${workflow ?? "(none)"}, and the tenant's GitHub Actions connection names ${expected}`,
      "Run the upload from the caller workflow the connection names, or reconnect with tumpel github-actions start --caller-workflow",
    );
  }
  const jobWorkflow = claimOf(claims, "job_workflow_ref");
  if (!isReusableWorkflow(jobWorkflow)) {
    return tokenMismatch(
      "job_workflow_ref",
      `the token comes from job workflow ${jobWorkflow ?? "(none)"}, and a prebuild uploads only from ${REUSABLE_WORKFLOW}`,
      `Call ${REUSABLE_WORKFLOW} or a release tag v1.x.y from the caller workflow, as tumpel github-actions get shows, then start the prebuild again; a commit SHA pin is refused because its job_workflow_ref names no release tag`,
    );
  }
  if (run.kind === "NoRun") {
    return tokenMismatch(
      "run_id",
      `prebuild ${prebuild.prebuildId} recorded no GitHub Actions run`,
      "Start a new prebuild with tumpel prebuild start --rebuild",
    );
  }
  const runId = claimOf(claims, "run_id");
  if (runId !== String(run.run.runId)) {
    return tokenMismatch(
      "run_id",
      `the token comes from run ${runId ?? "(none)"}, and prebuild ${prebuild.prebuildId} dispatched run ${run.run.runId}`,
      "Upload only from the run the prebuild dispatched",
    );
  }
  const sha = claimOf(claims, "sha");
  if (sha === run.run.headSha) return null;
  return tokenMismatch(
    "sha",
    `the token comes from a run of commit ${sha ?? "(none)"}, and prebuild ${prebuild.prebuildId} builds ${run.run.headSha}`,
    "Upload only from the run the prebuild dispatched, on the commit it read",
  );
};

const circleCIClaim = (claims: Record<string, unknown>, name: string): string | null =>
  claimOf(claims, `${CIRCLECI_CLAIM}/${name}`);

const otherJob = (prebuildId: string, jobId: string, recorded: string): Response =>
  tokenMismatch(
    "job-id",
    `the token comes from job ${jobId}, and prebuild ${prebuildId} took its upload from job ${recorded}`,
    "Upload and complete from the one upload job of the pipeline the prebuild triggered",
  );

const bindCircleCIClaims = (target: UploadTarget, claims: Record<string, unknown>): Response | null => {
  const { prebuild, defaultBranch, pipeline } = target;
  if (prebuild.provider !== "CircleCI") {
    return tokenMismatch(
      "provider",
      `prebuild ${prebuild.prebuildId} runs on ${prebuild.provider}, and a CircleCI job token uploads only the layer of a CircleCI prebuild`,
      "Upload the layer from the run the prebuild dispatched, with that provider's job token",
    );
  }
  if (pipeline.kind === "NoPipeline") {
    return tokenMismatch(
      "pipeline-id",
      `prebuild ${prebuild.prebuildId} recorded no CircleCI pipeline of a bound project`,
      "Bind the repository with tumpel circleci project add, then start a new prebuild with tumpel prebuild start --rebuild",
    );
  }
  const projectId = circleCIClaim(claims, "project-id");
  if (projectId !== pipeline.projectId) {
    return tokenMismatch(
      "project-id",
      `the token comes from project ${projectId ?? "(none)"}, and the repository's binding names project ${pipeline.projectId}`,
      "Upload only from the pipeline the prebuild triggered, in the project the binding names",
    );
  }
  const pipelineId = circleCIClaim(claims, "pipeline-id");
  if (pipelineId !== pipeline.pipelineId) {
    return tokenMismatch(
      "pipeline-id",
      `the token comes from pipeline ${pipelineId ?? "(none)"}, and prebuild ${prebuild.prebuildId} triggered pipeline ${pipeline.pipelineId}`,
      "Upload only from the pipeline the prebuild triggered",
    );
  }
  const ref = circleCIClaim(claims, "vcs-ref");
  const expectedRef = `refs/heads/${defaultBranch}`;
  if (ref !== expectedRef) {
    return tokenMismatch(
      "vcs-ref",
      `the token comes from a pipeline on ${ref ?? "(none)"}, and prebuild ${prebuild.prebuildId} builds ${expectedRef}`,
      "Upload only from the pipeline the prebuild triggered on the repository's default branch",
    );
  }
  if (claims[`${CIRCLECI_CLAIM}/ssh-rerun`] !== false) {
    return tokenMismatch(
      "ssh-rerun",
      "the token comes from a job rerun with SSH, or names no ssh-rerun, and a rerun with SSH hands a person a shell in the job",
      "Upload from the pipeline's own run; start a new prebuild with tumpel prebuild start --rebuild instead of rerunning a job with SSH",
    );
  }
  const jobId = circleCIClaim(claims, "job-id");
  if (jobId === null) {
    return tokenMismatch(
      "job-id",
      "the token names no job",
      "Mint the token with circleci run oidc get --aud <api origin> in the orb's upload job",
    );
  }
  if (pipeline.job.kind === "Job" && pipeline.job.jobId !== jobId) {
    return otherJob(prebuild.prebuildId, jobId, pipeline.job.jobId);
  }
  return null;
};

const targetOf = async (env: Env, prebuildId: string, tenantId: string): Promise<UploadTarget | null> => {
  const tenant = await env.DB.prepare("SELECT 1 FROM tenants WHERE tenant_id = ?").bind(tenantId).first();
  if (tenant === null) return null;
  return env.TENANT.getByName(tenantId).uploadTarget(tenantId, prebuildId);
};

const boundCircleCI = async (
  env: Env,
  organizationId: string,
  claims: Record<string, unknown>,
  prebuildId: string,
  tenantId: string,
): Promise<Bound> => {
  const target = await targetOf(env, prebuildId, tenantId);
  if (target === null) return { ok: false, response: notFound() };
  const organization = target.circleCIOrganization;
  if (organization.kind === "NotConnected" || organization.organizationId !== organizationId) {
    return { ok: false, response: notFound() };
  }
  const origin = circleCIClaim(claims, "vcs-origin");
  if (origin === null || `https://${origin.toLowerCase()}` !== target.prebuild.repository) {
    return { ok: false, response: notFound() };
  }
  const mismatch = bindCircleCIClaims(target, claims);
  if (mismatch !== null) return { ok: false, response: mismatch };
  return { ok: true, tenantId, target };
};

const boundGitHub = async (
  env: Env,
  claims: Record<string, unknown>,
  prebuildId: string,
  tenantId: string,
): Promise<Bound> => {
  const target = await targetOf(env, prebuildId, tenantId);
  if (target === null) return { ok: false, response: notFound() };
  const repository = claimOf(claims, "repository");
  if (repository === null || `https://github.com/${repository.toLowerCase()}` !== target.prebuild.repository) {
    return { ok: false, response: notFound() };
  }
  const mismatch = bindClaims(target, claims, repository);
  if (mismatch !== null) return { ok: false, response: mismatch };
  if (target.prebuild.status.state === "Dispatched" && target.run.kind === "Run") {
    await env.TENANT.getByName(tenantId).recordPrebuildBuilding(tenantId, prebuildId, target.run.run, Date.now());
  }
  return { ok: true, tenantId, target };
};

const bound = (env: Env, job: JobClaims, prebuildId: string, tenantId: string): Promise<Bound> =>
  job.issuer.provider === "CircleCI"
    ? boundCircleCI(env, job.issuer.organizationId, job.claims, prebuildId, tenantId)
    : boundGitHub(env, job.claims, prebuildId, tenantId);

const bindCircleCIJob = async (env: Env, job: JobClaims, binding: UploadTarget, tenantId: string) => {
  const { prebuild, pipeline } = binding;
  if (job.issuer.provider !== "CircleCI" || pipeline.kind === "NoPipeline" || pipeline.job.kind === "Job") return null;
  const jobId = circleCIClaim(job.claims, "job-id");
  if (jobId === null)
    throw new Error(`the job token of prebuild ${prebuild.prebuildId} lost its job-id after its check`);
  const tenant = env.TENANT.getByName(tenantId);
  const recorded = await tenant.bindCircleCIUploadJob(tenantId, prebuild.prebuildId, jobId, Date.now());
  if (recorded.kind === "Bound") return null;
  if (recorded.kind === "OtherJob") return otherJob(prebuild.prebuildId, jobId, recorded.jobId);
  if (recorded.kind === "RevisionMoved") return notUploading(recorded.prebuild);
  return circleCIRefused(recorded, `reading pipeline ${pipeline.pipelineId} for the commit it checked out`);
};

const start = async (env: Env, binding: UploadTarget, tenantId: string, upload: PrebuildLayerUpload) => {
  const { prebuildId } = binding.prebuild;
  const recorded = await env.TENANT.getByName(tenantId).startPrebuildUpload(tenantId, prebuildId, upload, Date.now());
  if (recorded.kind === "NotUploading") return notUploading(recorded.prebuild);
  if (recorded.kind === "OtherLayer") {
    return problem(409, {
      code: "Conflict",
      title: "Another layer already started",
      detail: `prebuild ${prebuildId} recorded layer ${recorded.recorded.layerDigest} of ${recorded.recorded.layerSizeBytes} bytes, and this start names ${upload.layerDigest} of ${upload.layerSizeBytes} bytes`,
      fix: "Upload the layer the first start named, or start a new prebuild with tumpel prebuild start --rebuild",
    });
  }
  const signer = signerOf(env, env.R2_BUCKET_NAME, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY);
  const seconds = settingsOf(env).prebuildUploadBudgetSeconds;
  const now = Date.now();
  return json(
    PrebuildUploadGrantSchema.parse({
      prebuildId,
      tenantId,
      sha256: upload.layerDigest,
      url: await signer.presignChecked(
        prebuildLayerKey(tenantId, prebuildId, upload.layerDigest),
        upload.layerDigest,
        upload.layerSizeBytes,
        seconds,
        new Date(now),
      ),
      uploadExpiresAt: new Date(now + seconds * 1000).toISOString(),
    }),
  );
};

const complete = async (env: Env, binding: UploadTarget, tenantId: string): Promise<Response> => {
  const { prebuild, upload } = binding;
  const stored =
    upload === null ? null : await env.STORE.head(prebuildLayerKey(tenantId, prebuild.prebuildId, upload.layerDigest));
  if (upload === null || stored === null) {
    return problem(409, {
      code: "LayerNotUploaded",
      title: "Layer not uploaded",
      detail:
        upload === null
          ? `prebuild ${prebuild.prebuildId} has no upload started`
          : `the bucket holds no layer ${upload.layerDigest} for prebuild ${prebuild.prebuildId}`,
      fix: "Start the upload, PUT the layer to the URL it answered, then call complete",
    });
  }
  const recorded = await env.TENANT.getByName(tenantId).completePrebuildUpload(
    tenantId,
    prebuild.prebuildId,
    upload,
    Date.now(),
  );
  if (recorded.kind !== "Recorded") return notUploading(recorded.prebuild);
  return json(recorded.prebuild);
};

export const handlePrebuildUploads = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  const route = UPLOADS_PATH.exec(url.pathname);
  if (route === null || request.method !== "POST") return null;
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (token === "") return tokenRefused("token", "the request carries no Authorization: Bearer token", url.origin);
  const issuer = jobIssuerOf(env, token);
  const verify =
    issuer.provider === "CircleCI" ? circleCIVerifierFor(issuer.issuer, url.origin) : verifierFor(env, url.origin);
  const verified = await verify(token);
  if (!verified.ok) return tokenRefused(verified.check, verified.detail, url.origin);
  const job: JobClaims = { issuer, claims: verified.claims };
  const path = PrebuildPathSchema.safeParse({ prebuildId: decodeURIComponent(route[1] ?? "") });
  if (!path.success) return notFound();
  const { prebuildId } = path.data;
  if (route[2] === "/complete") {
    const body = await parseBody(request, PrebuildUploadCompleteSchema, "prebuildUploads.complete");
    if (!body.ok) return body.response;
    const binding = await bound(env, job, prebuildId, body.value.tenantId);
    if (!binding.ok) return binding.response;
    return complete(env, binding.target, binding.tenantId);
  }
  const body = await parseBody(request, PrebuildUploadStartSchema, "prebuildUploads.start");
  if (!body.ok) return body.response;
  const binding = await bound(env, job, prebuildId, body.value.tenantId);
  if (!binding.ok) return binding.response;
  const unbound = await bindCircleCIJob(env, job, binding.target, binding.tenantId);
  if (unbound !== null) return unbound;
  const { layerDigest, layerSizeBytes } = body.value;
  return start(env, binding.target, binding.tenantId, { layerDigest, layerSizeBytes });
};
