import {
  PrebuildPathSchema,
  PrebuildUploadCompleteSchema,
  PrebuildUploadGrantSchema,
  PrebuildUploadStartSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { json, parseBody, problem } from "./http";
import type { Env } from "./index";
import { verifyJobToken } from "./job-token.ts";
import { signerOf } from "./presign";
import { settingsOf } from "./settings";
import type { BuildProvider, JobBinding, Prebuild } from "./tenant-prebuilds";

type PrebuildUploadGrant = z.infer<typeof PrebuildUploadGrantSchema>;
type UploadFile = z.infer<typeof PrebuildUploadStartSchema>["manifest"];

type Bound = { ok: true; prebuild: Prebuild } | { ok: false; response: Response };

const UPLOADS_PATH = /^\/v1\/prebuilds\/([^/]+)\/uploads(\/complete)?$/;

const ISSUER_SETTING: Record<BuildProvider, "gitHubActions" | "namespaceBuilds"> = {
  GitHubActions: "gitHubActions",
  Namespace: "namespaceBuilds",
};

const TOKEN_FIX: Record<BuildProvider, string> = {
  GitHubActions:
    "Request the job token with the audience of this API's origin from the job of the caller workflow (permissions id-token: write), and present it as Authorization: Bearer <token> within its lifetime",
  Namespace:
    "Issue the token with nsc auth issue-id-token --audience <this API's origin> in the connected workspace, and present it as Authorization: Bearer <token> within its lifetime",
};

export const prebuildBlobKey = (tenantId: string, prebuildId: string, digest: string): string =>
  `${tenantId}/prebuilds/${prebuildId}/blobs/${digest}`;

export const prebuildManifestKey = (tenantId: string, prebuildId: string): string =>
  `${tenantId}/prebuilds/${prebuildId}/manifest.json`;

const tokenRefused = (provider: BuildProvider, check: string, detail: string): Response =>
  problem(
    401,
    { code: "JobTokenRefused", title: `Job token refused: ${check}`, detail, fix: TOKEN_FIX[provider] },
    { "www-authenticate": "Bearer" },
  );

const tokenMismatch = (check: string, detail: string, fix: string): Response =>
  problem(403, { code: "JobTokenMismatch", title: `Job token refused: ${check}`, detail, fix });

const notFound = (tenantId: string, prebuildId: string): Response =>
  problem(404, {
    code: "NotFound",
    title: "No such prebuild",
    detail: `tenant ${tenantId} has no prebuild ${prebuildId}`,
    fix: "Pass the tenantId and prebuildId the dispatch handed the job",
  });

const notUploading = (prebuild: Prebuild): Response =>
  problem(409, {
    code: "PrebuildNotUploading",
    title: "Prebuild past its upload",
    detail: `prebuild ${prebuild.prebuildId} is ${prebuild.status.state}, and only a Dispatched or Building prebuild takes a layer`,
    fix: `Start a new prebuild with tumpel prebuild start --rebuild, and read this one with tumpel prebuild get ${prebuild.prebuildId}`,
  });

const claimOf = (claims: Record<string, unknown>, name: string): string | null => {
  const value = claims[name];
  return typeof value === "string" ? value : null;
};

const bindClaims = (prebuild: Prebuild, binding: JobBinding, claims: Record<string, unknown>): Response | null => {
  if (binding.provider === "Namespace") {
    const workspace = claimOf(claims, "tenant_id");
    if (workspace === binding.workspaceId) return null;
    return tokenMismatch(
      "tenant_id",
      `the token names Namespace workspace ${workspace ?? "(none)"}, and the tenant connected workspace ${binding.workspaceId}`,
      "Run the build in the connected workspace, or connect this workspace with tumpel namespace start --workspace-id",
    );
  }
  const repository = claimOf(claims, "repository");
  if (repository === null || `https://github.com/${repository.toLowerCase()}` !== prebuild.repository) {
    return tokenMismatch(
      "repository",
      `the token comes from repository ${repository ?? "(none)"}, and prebuild ${prebuild.prebuildId} builds ${prebuild.repository}`,
      "Upload a prebuild's layer only from a run in its own repository",
    );
  }
  const workflow = claimOf(claims, "workflow_ref")?.split("@")[0] ?? null;
  const expected = `${repository}/${binding.callerWorkflow}`;
  if (workflow === expected) return null;
  return tokenMismatch(
    "workflow_ref",
    `the token comes from workflow ${workflow ?? "(none)"}, and the tenant's GitHub Actions connection names ${expected}`,
    "Run the upload from the caller workflow the connection names, or reconnect with tumpel github-actions start --caller-workflow",
  );
};

const bound = async (request: Request, url: URL, env: Env, prebuildId: string, tenantId: string): Promise<Bound> => {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  const tenant = await env.DB.prepare("SELECT 1 FROM tenants WHERE tenant_id = ?").bind(tenantId).first();
  if (tenant === null) return { ok: false, response: notFound(tenantId, prebuildId) };
  const stub = env.TENANT.getByName(tenantId);
  const prebuild = await stub.getPrebuild(tenantId, prebuildId);
  if (prebuild === null) return { ok: false, response: notFound(tenantId, prebuildId) };
  const { provider } = prebuild;
  if (token === "") {
    return {
      ok: false,
      response: tokenRefused(provider, "token", "the request carries no Authorization: Bearer token"),
    };
  }
  const issuer = settingsOf(env).buildProviderIssuers[ISSUER_SETTING[provider]].replace(/\/+$/, "");
  const verified = await verifyJobToken(token, issuer, url.origin, Date.now());
  if (!verified.ok) return { ok: false, response: tokenRefused(provider, verified.check, verified.detail) };
  const binding = await stub.jobBinding(provider);
  if (binding === null) {
    return {
      ok: false,
      response: tokenMismatch(
        "connection",
        `tenant ${tenantId} has disconnected ${provider}, which ran prebuild ${prebuildId}`,
        "Reconnect the build provider, then start the prebuild again",
      ),
    };
  }
  const mismatch = bindClaims(prebuild, binding, verified.claims);
  if (mismatch !== null) return { ok: false, response: mismatch };
  if (prebuild.status.state !== "Dispatched" && prebuild.status.state !== "Building") {
    return { ok: false, response: notUploading(prebuild) };
  }
  return { ok: true, prebuild };
};

const presignUploads = async (
  env: Env,
  prebuild: Prebuild,
  blobs: UploadFile[],
  manifest: UploadFile,
  now: number,
): Promise<PrebuildUploadGrant> => {
  const signer = signerOf(env, env.R2_BUCKET_NAME, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY);
  const seconds = settingsOf(env).prebuildUploadBudgetSeconds;
  const at = new Date(now);
  const { tenantId, prebuildId } = prebuild;
  const signed = async (file: UploadFile, storageKey: string) => ({
    ...file,
    uploadUrl: await signer.presignChecked(storageKey, file.digest, seconds, at),
  });
  return PrebuildUploadGrantSchema.parse({
    prebuildId,
    tenantId,
    blobs: await Promise.all(blobs.map((blob) => signed(blob, prebuildBlobKey(tenantId, prebuildId, blob.digest)))),
    manifest: await signed(manifest, prebuildManifestKey(tenantId, prebuildId)),
    uploadExpiresAt: new Date(now + seconds * 1000).toISOString(),
  });
};

const complete = async (request: Request, url: URL, env: Env, prebuildId: string): Promise<Response> => {
  const body = await parseBody(request, PrebuildUploadCompleteSchema, "prebuildUploads.complete");
  if (!body.ok) return body.response;
  const { tenantId, layerDigest, layerSizeBytes } = body.value;
  const binding = await bound(request, url, env, prebuildId, tenantId);
  if (!binding.ok) return binding.response;
  const stored = await env.STORE.head(prebuildBlobKey(tenantId, prebuildId, layerDigest));
  if (stored === null || stored.size !== layerSizeBytes) {
    return problem(409, {
      code: "LayerNotUploaded",
      title: "Layer not uploaded",
      detail:
        stored === null
          ? `the bucket holds no layer blob ${layerDigest} for prebuild ${prebuildId}`
          : `the bucket holds layer blob ${layerDigest} of prebuild ${prebuildId} at ${stored.size} bytes, not ${layerSizeBytes}`,
      fix: "PUT the layer blob to the URL the upload exchange answered, then call complete with its digest and size",
    });
  }
  const recorded = await env.TENANT.getByName(tenantId).recordPrebuildUpload(
    tenantId,
    prebuildId,
    { layerDigest, layerSizeBytes },
    Date.now(),
  );
  if (recorded.kind === "NotUploading") return notUploading(recorded.prebuild);
  return json(recorded.prebuild);
};

export const handlePrebuildUploads = async (request: Request, url: URL, env: Env): Promise<Response | null> => {
  const route = UPLOADS_PATH.exec(url.pathname);
  if (route === null || request.method !== "POST") return null;
  const raw = decodeURIComponent(route[1] ?? "");
  const path = PrebuildPathSchema.safeParse({ prebuildId: raw });
  if (!path.success) {
    return problem(404, {
      code: "NotFound",
      title: "No such prebuild",
      detail: `${raw} is no prebuild id`,
      fix: "Pass the prebuildId the dispatch handed the job",
    });
  }
  const { prebuildId } = path.data;
  if (route[2] === "/complete") return complete(request, url, env, prebuildId);
  const body = await parseBody(request, PrebuildUploadStartSchema, "prebuildUploads.start");
  if (!body.ok) return body.response;
  const binding = await bound(request, url, env, prebuildId, body.value.tenantId);
  if (!binding.ok) return binding.response;
  return json(await presignUploads(env, binding.prebuild, body.value.blobs, body.value.manifest, Date.now()));
};
