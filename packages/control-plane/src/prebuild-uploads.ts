import {
  PrebuildJobInputsSchema,
  PrebuildPathSchema,
  PrebuildUploadCompleteSchema,
  PrebuildUploadGrantSchema,
  PrebuildUploadStartSchema,
} from "@tumpel/api/schemas";
import { circleCIRefused } from "./circleci-projects.ts";
import { REUSABLE_WORKFLOW, REUSABLE_WORKFLOW_PATH, REUSABLE_WORKFLOW_TAGS, RUN_EVENTS } from "./github-actions";
import { tenantOfAccount } from "./github-store.ts";
import { json, parseBody, problem } from "./http";
import type { Env } from "./index";
import { type JwtCheck, jwtVerifier, unverifiedIssuer, type VerifiedJwt, type VerifyJwt } from "./jwt";
import { presignRootfs } from "./prebuilds";
import { signerOf } from "./presign";
import { settingsOf } from "./settings";
import type {
  CallerWorkflow,
  CircleCIUploadTarget,
  GitHubActionsUploadTarget,
  Prebuild,
  PrebuildLayerUpload,
  UploadTarget,
} from "./tenant-prebuilds";

type UnboundJob = { kind: "None" } | { kind: "CircleCI"; target: CircleCIUploadTarget; jobId: string };

type Bound =
  | { ok: true; tenantId: string; target: UploadTarget; unbound: UnboundJob }
  | { ok: false; response: Response };

type ClaimsBound = { ok: true; jobId: string } | { ok: false; response: Response };

type JobIssuer = { provider: "GitHubActions" } | { provider: "CircleCI"; issuer: string; organizationId: string };

type JobClaims = { issuer: JobIssuer; claims: Record<string, unknown> };

const UPLOADS_PATH = /^\/v1\/prebuilds\/([^/]+)\/uploads(\/complete)?$/;
const INPUTS_PATH = "/v1/prebuild-inputs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CIRCLECI_CLAIM = "oidc.circleci.com";
const CIRCLECI_VERIFIER_CAP = 64;
const KEYS_LOADED: ReadonlySet<JwtCheck> = new Set(["kid", "signature", "iss", "aud", "exp", "nbf"]);

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

const rememberCircleCIVerifier = (key: string, verify: VerifyJwt): void => {
  const oldest = circleCIVerifiers.keys().next();
  if (circleCIVerifiers.size >= CIRCLECI_VERIFIER_CAP && oldest.done === false) circleCIVerifiers.delete(oldest.value);
  circleCIVerifiers.set(key, verify);
};

const verifyCircleCI = async (issuer: string, audience: string, token: string): Promise<VerifiedJwt> => {
  const key = `${issuer} ${audience}`;
  const held = circleCIVerifiers.get(key);
  if (held !== undefined) return held(token);
  const verify = jwtVerifier(`${issuer}/.well-known/jwks-pub.json`, issuer, audience);
  const verified = await verify(token);
  if (verified.ok || KEYS_LOADED.has(verified.check)) rememberCircleCIVerifier(key, verify);
  return verified;
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
    fix: `Upload from the run the prebuild dispatched once it runs, or start a new prebuild with rebuild set; read prebuild ${prebuild.prebuildId} to follow this one`,
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

interface RunTarget {
  prebuildId: string;
  defaultBranch: string;
  callerWorkflow: CallerWorkflow;
  headSha: string;
}

const checkRunClaims = (target: RunTarget, claims: Record<string, unknown>, repository: string): Response | null => {
  const { prebuildId, defaultBranch, callerWorkflow, headSha } = target;
  if (callerWorkflow.kind === "NotConnected") {
    return tokenMismatch(
      "connection",
      "the tenant has no GitHub Actions connection",
      "Connect GitHub Actions again, then start the prebuild",
    );
  }
  const ref = claimOf(claims, "ref");
  const expectedRef = `refs/heads/${defaultBranch}`;
  if (ref !== expectedRef) {
    return tokenMismatch(
      "ref",
      `the token comes from a run on ${ref ?? "(none)"}, and prebuild ${prebuildId} builds ${expectedRef}`,
      "Run the prebuild only from the caller workflow on the repository's default branch",
    );
  }
  const event = claimOf(claims, "event_name");
  if (event === null || !RUN_EVENTS.includes(event)) {
    return tokenMismatch(
      "event_name",
      `the token comes from a run triggered by ${event ?? "(none)"}, and a prebuild runs only on ${RUN_EVENTS.join(" or ")}`,
      "Run the prebuild only from the run its start began",
    );
  }
  const workflow = claimOf(claims, "workflow_ref");
  const expected = `${repository}/${callerWorkflow.callerWorkflow}@${expectedRef}`;
  if (workflow !== expected) {
    return tokenMismatch(
      "workflow_ref",
      `the token comes from workflow ${workflow ?? "(none)"}, and the tenant's GitHub Actions connection names ${expected}`,
      "Run the prebuild from the caller workflow the connection names, or connect GitHub Actions again with this caller workflow",
    );
  }
  const jobWorkflow = claimOf(claims, "job_workflow_ref");
  if (!isReusableWorkflow(jobWorkflow)) {
    return tokenMismatch(
      "job_workflow_ref",
      `the token comes from job workflow ${jobWorkflow ?? "(none)"}, and a prebuild runs only in ${REUSABLE_WORKFLOW}`,
      `Call ${REUSABLE_WORKFLOW} or a release tag v2.x.y from the caller workflow, as the GitHub Actions connection shows; a commit SHA pin is refused because its job_workflow_ref names no release tag`,
    );
  }
  const sha = claimOf(claims, "sha");
  if (sha === headSha) return null;
  return tokenMismatch(
    "sha",
    `the token comes from a run of commit ${sha ?? "(none)"}, and prebuild ${prebuildId} builds ${headSha}`,
    "Run the prebuild only from the run of the commit its start read",
  );
};

const bindClaims = (
  target: GitHubActionsUploadTarget,
  claims: Record<string, unknown>,
  repository: string,
): Response | null => {
  const { prebuild, defaultBranch, callerWorkflow, run } = target;
  const runId = claimOf(claims, "run_id");
  if (runId !== String(run.runId)) {
    return tokenMismatch(
      "run_id",
      `the token comes from run ${runId ?? "(none)"}, and prebuild ${prebuild.prebuildId} runs in run ${run.runId}`,
      "Upload only from the run that read the prebuild's inputs",
    );
  }
  return checkRunClaims(
    { prebuildId: prebuild.prebuildId, defaultBranch, callerWorkflow, headSha: run.headSha },
    claims,
    repository,
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

const bindCircleCIClaims = (target: CircleCIUploadTarget, claims: Record<string, unknown>): ClaimsBound => {
  const { prebuild, defaultBranch, pipeline } = target;
  const mismatch = (response: Response): ClaimsBound => ({ ok: false, response });
  const projectId = circleCIClaim(claims, "project-id");
  if (projectId !== pipeline.projectId) {
    return mismatch(
      tokenMismatch(
        "project-id",
        `the token comes from project ${projectId ?? "(none)"}, and the repository's binding names project ${pipeline.projectId}`,
        "Upload only from the pipeline the prebuild triggered, in the project the binding names",
      ),
    );
  }
  const pipelineId = circleCIClaim(claims, "pipeline-id");
  if (pipelineId !== pipeline.pipelineId) {
    return mismatch(
      tokenMismatch(
        "pipeline-id",
        `the token comes from pipeline ${pipelineId ?? "(none)"}, and prebuild ${prebuild.prebuildId} triggered pipeline ${pipeline.pipelineId}`,
        "Upload only from the pipeline the prebuild triggered",
      ),
    );
  }
  const ref = circleCIClaim(claims, "vcs-ref");
  const expectedRef = `refs/heads/${defaultBranch}`;
  if (ref !== expectedRef) {
    return mismatch(
      tokenMismatch(
        "vcs-ref",
        `the token comes from a pipeline on ${ref ?? "(none)"}, and prebuild ${prebuild.prebuildId} builds ${expectedRef}`,
        "Upload only from the pipeline the prebuild triggered on the repository's default branch",
      ),
    );
  }
  if (claims[`${CIRCLECI_CLAIM}/ssh-rerun`] !== false) {
    return mismatch(
      tokenMismatch(
        "ssh-rerun",
        "the token comes from a job rerun with SSH, or names no ssh-rerun, and a rerun with SSH hands a person a shell in the job",
        "Upload from the pipeline's own run; start a new prebuild with rebuild set instead of rerunning a job with SSH",
      ),
    );
  }
  const jobId = circleCIClaim(claims, "job-id");
  if (jobId === null) {
    return mismatch(
      tokenMismatch(
        "job-id",
        "the token names no job",
        "Mint the token with circleci run oidc get --aud <api origin> in the orb's upload job",
      ),
    );
  }
  if (pipeline.job.kind === "Job" && pipeline.job.jobId !== jobId) {
    return mismatch(otherJob(prebuild.prebuildId, jobId, pipeline.job.jobId));
  }
  return { ok: true, jobId };
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
  if (target === null || target.provider !== "CircleCI" || target.organizationId !== organizationId) {
    return { ok: false, response: notFound() };
  }
  const origin = circleCIClaim(claims, "vcs-origin");
  if (origin === null || `https://${origin.toLowerCase()}` !== target.prebuild.repository) {
    return { ok: false, response: notFound() };
  }
  const claimed = bindCircleCIClaims(target, claims);
  if (!claimed.ok) return claimed;
  const unbound: UnboundJob =
    target.pipeline.job.kind === "Job" ? { kind: "None" } : { kind: "CircleCI", target, jobId: claimed.jobId };
  return { ok: true, tenantId, target, unbound };
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
  if (target.provider !== "GitHubActions") {
    return {
      ok: false,
      response: tokenMismatch(
        "provider",
        `prebuild ${target.prebuild.prebuildId} runs on ${target.prebuild.provider}, and a GitHub Actions job token uploads only the layer of a GitHub Actions prebuild`,
        "Upload the layer from the run the prebuild dispatched, with that provider's job token",
      ),
    };
  }
  const mismatch = bindClaims(target, claims, repository);
  if (mismatch !== null) return { ok: false, response: mismatch };
  if (target.prebuild.status.state === "Dispatched") {
    await env.TENANT.getByName(tenantId).recordPrebuildBuilding(tenantId, prebuildId, Date.now());
  }
  return { ok: true, tenantId, target, unbound: { kind: "None" } };
};

const bound = (env: Env, job: JobClaims, prebuildId: string, tenantId: string): Promise<Bound> =>
  job.issuer.provider === "CircleCI"
    ? boundCircleCI(env, job.issuer.organizationId, job.claims, prebuildId, tenantId)
    : boundGitHub(env, job.claims, prebuildId, tenantId);

const bindCircleCIJob = async (env: Env, unbound: UnboundJob, tenantId: string): Promise<Response | null> => {
  if (unbound.kind === "None") return null;
  const { target, jobId } = unbound;
  const { prebuildId } = target.prebuild;
  const { pipelineId, headSha } = target.pipeline;
  const recorded = await env.TENANT.getByName(tenantId).bindCircleCIUploadJob(
    tenantId,
    prebuildId,
    { pipelineId, headSha, jobId },
    Date.now(),
  );
  if (recorded.kind === "Bound") return null;
  if (recorded.kind === "OtherJob") return otherJob(prebuildId, jobId, recorded.jobId);
  if (recorded.kind === "RevisionMoved") return notUploading(recorded.prebuild);
  return circleCIRefused(recorded, `reading pipeline ${pipelineId} for the commit it checked out`);
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
      fix: "Upload the layer the first start named, or start a new prebuild with rebuild set",
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
  const verified =
    issuer.provider === "CircleCI"
      ? await verifyCircleCI(issuer.issuer, url.origin, token)
      : await verifierFor(env, url.origin)(token);
  if (!verified.ok && verified.check === "keys" && issuer.provider === "CircleCI") return notFound();
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
  const unbound = await bindCircleCIJob(env, binding.unbound, binding.tenantId);
  if (unbound !== null) return unbound;
  const { layerDigest, layerSizeBytes } = body.value;
  return start(env, binding.target, binding.tenantId, { layerDigest, layerSizeBytes });
};

const noRunPrebuild = (repository: string, sha: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No prebuild for this run",
    detail: `no prebuild of ${repository} waits for a run at commit ${sha}`,
    fix: "Start the prebuild, which begins its run; a run Tumpel did not begin, such as a push of a hand-edited caller workflow, has no prebuild",
  });

const notRunning = (prebuild: Prebuild): Response =>
  problem(409, {
    code: "PrebuildNotUploading",
    title: "Prebuild not running",
    detail: `prebuild ${prebuild.prebuildId} is ${prebuild.status.state}, and only a Dispatched or Building prebuild hands its run the inputs`,
    fix: `Start a new prebuild with rebuild set; read prebuild ${prebuild.prebuildId} to follow this one`,
  });

export const handlePrebuildInputs = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  if (url.pathname !== INPUTS_PATH || request.method !== "POST") return null;
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (token === "") return tokenRefused("token", "the request carries no Authorization: Bearer token", url.origin);
  const verified = await verifierFor(env, url.origin)(token);
  if (!verified.ok) return tokenRefused(verified.check, verified.detail, url.origin);
  const { claims } = verified;
  const repository = claimOf(claims, "repository");
  const sha = claimOf(claims, "sha");
  const runId = Number(claimOf(claims, "run_id"));
  if (repository === null || sha === null || !Number.isSafeInteger(runId)) {
    return tokenMismatch(
      "repository",
      "the token names no repository, sha or run_id",
      "Present a GitHub Actions job token of the caller workflow's run",
    );
  }
  const repositoryUrl = `https://github.com/${repository.toLowerCase()}`;
  const tenantId = await tenantOfAccount(env.DB, repository.slice(0, repository.indexOf("/")));
  if (tenantId === null) return noRunPrebuild(repositoryUrl, sha);
  const tenant = env.TENANT.getByName(tenantId);
  const target = await tenant.jobInputsTarget(tenantId, repositoryUrl, sha, runId);
  if (target === null) return noRunPrebuild(repositoryUrl, sha);
  const { prebuild } = target;
  const mismatch = checkRunClaims(
    {
      prebuildId: prebuild.prebuildId,
      defaultBranch: target.defaultBranch,
      callerWorkflow: target.callerWorkflow,
      headSha: target.headSha,
    },
    claims,
    repository,
  );
  if (mismatch !== null) return mismatch;
  if (prebuild.status.state !== "Dispatched" && prebuild.status.state !== "Building") return notRunning(prebuild);
  const now = Date.now();
  const bound = await tenant.bindJobRun(tenantId, prebuild.prebuildId, runId, now);
  if (bound.kind === "OtherRun") {
    return tokenMismatch(
      "run_id",
      `the token comes from run ${runId}, and prebuild ${prebuild.prebuildId} runs in run ${bound.runId}`,
      "Run the prebuild only from the run that first read its inputs",
    );
  }
  return json(
    PrebuildJobInputsSchema.parse({
      prebuildId: prebuild.prebuildId,
      tenantId,
      rootfsUrl: await presignRootfs(env, target.rootfsKey, now),
      imageDigest: prebuild.guestImageDigest,
    }),
  );
};
