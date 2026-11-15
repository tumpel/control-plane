import { z } from "zod";
import type { Fetch } from "./github.ts";

export const CIRCLECI_ORB = "tumpel/prebuild@1";

export const CIRCLECI_PARAMETERS = [
  "tumpel_prebuild_id",
  "tumpel_tenant_id",
  "tumpel_api_origin",
  "tumpel_rootfs_url",
  "tumpel_image_digest",
] as const;

export type CircleCIParameter = (typeof CIRCLECI_PARAMETERS)[number];

export const CIRCLECI_WORKFLOW = "tumpel-prebuild";
export const CIRCLECI_PARAMETER_LIMIT = 512;

export interface CircleCIInputs {
  prebuildId: string;
  tenantId: string;
  apiOrigin: string;
  rootfsUrl: string;
  imageDigest: string;
}

export const circleCIParameters = (inputs: CircleCIInputs): Record<CircleCIParameter, string> => ({
  tumpel_prebuild_id: inputs.prebuildId,
  tumpel_tenant_id: inputs.tenantId,
  tumpel_api_origin: inputs.apiOrigin,
  tumpel_rootfs_url: inputs.rootfsUrl,
  tumpel_image_digest: inputs.imageDigest,
});

export const overLongParameter = (parameters: Record<string, string>): { name: string; length: number } | null => {
  for (const [name, value] of Object.entries(parameters)) {
    if (value.length > CIRCLECI_PARAMETER_LIMIT) return { name, length: value.length };
  }
  return null;
};

export const CIRCLECI_CONFIG_EXAMPLE = [
  "version: 2.1",
  "orbs:",
  `  tumpel: ${CIRCLECI_ORB}`,
  "parameters:",
  ...CIRCLECI_PARAMETERS.map((name) => `  ${name}: { type: string, default: "" }`),
  "workflows:",
  `  ${CIRCLECI_WORKFLOW}:`,
  "    jobs:",
  "      - tumpel/build:",
  "          rootfs-url: << pipeline.parameters.tumpel_rootfs_url >>",
  "          image-digest: << pipeline.parameters.tumpel_image_digest >>",
  "      - tumpel/upload:",
  "          requires: [tumpel/build]",
  "          prebuild-id: << pipeline.parameters.tumpel_prebuild_id >>",
  "          tenant-id: << pipeline.parameters.tumpel_tenant_id >>",
  "          api-origin: << pipeline.parameters.tumpel_api_origin >>",
  "          rootfs-url: << pipeline.parameters.tumpel_rootfs_url >>",
  "",
].join("\n");

export const circleCIIssuer = (oidcOrigin: string, organizationId: string): string =>
  `${oidcOrigin.replace(/\/+$/, "")}/org/${organizationId}`;

export type CircleCIAnswer<T> = { ok: true; status: number; value: T } | { ok: false; status: number; detail: string };

const CIRCLECI_TIMEOUT_MS = 10_000;

const ErrorSchema = z.object({ message: z.string() });

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const failed = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export const callCircleCI = async <T>(
  fetcher: Fetch,
  request: { method: "GET" | "POST" | "DELETE"; url: string; token: string; body: unknown },
  schema: z.ZodType<T>,
  answerName: string,
): Promise<CircleCIAnswer<T>> => {
  const { method, url, token, body } = request;
  const path = new URL(url).pathname;
  const headers: Record<string, string> = { accept: "application/json", "circle-token": token, "user-agent": "tumpel" };
  if (body !== null) headers["content-type"] = "application/json";
  const response = await fetcher(url, {
    method,
    headers,
    body: body === null ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(CIRCLECI_TIMEOUT_MS),
  }).catch(failed);
  if (response instanceof Error) {
    return {
      ok: false,
      status: 0,
      detail: `CircleCI did not answer ${method} ${path} within ${CIRCLECI_TIMEOUT_MS / 1000} s: ${response.message}`,
    };
  }
  const text = await response.text();
  if (!response.ok) {
    const error = ErrorSchema.safeParse(parseJson(text));
    return {
      ok: false,
      status: response.status,
      detail: `CircleCI answered ${method} ${path} with ${response.status}: ${error.success ? error.data.message : "no error message"}`,
    };
  }
  const parsed = schema.safeParse(parseJson(text));
  if (parsed.success) return { ok: true, status: response.status, value: parsed.data };
  return {
    ok: false,
    status: response.status,
    detail: `CircleCI answered ${method} ${path} with a body that is not a ${answerName}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")}`,
  };
};

const v2 = (api: string, path: string): string => `${api.replace(/\/+$/, "")}/api/v2${path}`;

const MeSchema = z.object({ id: z.string(), login: z.string() });

const ProjectSchema = z.object({ id: z.string(), slug: z.string(), organization_id: z.string() });

const RepoSchema = z.object({ full_name: z.string() });

const PipelineDefinitionSchema = z.object({
  id: z.string(),
  config_source: z.object({ repo: RepoSchema, file_path: z.string() }),
  checkout_source: z.object({ repo: RepoSchema }),
});

export type CircleCIProjectAnswer = z.infer<typeof ProjectSchema>;
export type CircleCIPipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;

const slugPath = (slug: string): string => slug.split("/").map(encodeURIComponent).join("/");

export const readMe = (fetcher: Fetch, api: string, token: string) =>
  callCircleCI(fetcher, { method: "GET", url: v2(api, "/me"), token, body: null }, MeSchema, "CircleCIUser");

export const readProject = (fetcher: Fetch, api: string, token: string, slug: string) =>
  callCircleCI(
    fetcher,
    { method: "GET", url: v2(api, `/project/${slugPath(slug)}`), token, body: null },
    ProjectSchema,
    "CircleCIProject",
  );

export const readPipelineDefinition = (
  fetcher: Fetch,
  api: string,
  token: string,
  projectId: string,
  definitionId: string,
) =>
  callCircleCI(
    fetcher,
    {
      method: "GET",
      url: v2(
        api,
        `/projects/${encodeURIComponent(projectId)}/pipeline-definitions/${encodeURIComponent(definitionId)}`,
      ),
      token,
      body: null,
    },
    PipelineDefinitionSchema,
    "CircleCIPipelineDefinition",
  );

const PipelineCreatedSchema = z.object({ id: z.string(), state: z.string(), number: z.number() });
const PipelineRunSchema = z.union([PipelineCreatedSchema, z.object({ message: z.string() })]);

export type PipelineRun =
  | { kind: "Created"; pipelineId: string; number: number }
  | { kind: "Refused"; status: number; detail: string };

export const triggerPipeline = async (
  fetcher: Fetch,
  api: string,
  token: string,
  run: { projectSlug: string; definitionId: string; branch: string; parameters: Record<string, string> },
): Promise<PipelineRun> => {
  const path = `/project/${slugPath(run.projectSlug)}/pipeline/run`;
  const answer = await callCircleCI(
    fetcher,
    {
      method: "POST",
      url: v2(api, path),
      token,
      body: {
        definition_id: run.definitionId,
        config: { branch: run.branch },
        checkout: { branch: run.branch },
        parameters: run.parameters,
      },
    },
    PipelineRunSchema,
    "CircleCIPipelineRun",
  );
  if (!answer.ok) return { kind: "Refused", status: answer.status, detail: answer.detail };
  if ("message" in answer.value) {
    return {
      kind: "Refused",
      status: answer.status,
      detail: `CircleCI answered POST /api/v2${path} with ${answer.status} and created no pipeline: ${answer.value.message}`,
    };
  }
  if (answer.status !== 201 || answer.value.state === "errored") {
    return {
      kind: "Refused",
      status: answer.status,
      detail: `CircleCI answered POST /api/v2${path} with ${answer.status} and pipeline ${answer.value.id} in state ${answer.value.state}`,
    };
  }
  return { kind: "Created", pipelineId: answer.value.id, number: answer.value.number };
};

const PipelineSchema = z.object({ id: z.string(), vcs: z.object({ revision: z.string() }) });

export const readPipelineRevision = async (
  fetcher: Fetch,
  api: string,
  token: string,
  pipelineId: string,
): Promise<CircleCIAnswer<string>> => {
  const answer = await callCircleCI(
    fetcher,
    { method: "GET", url: v2(api, `/pipeline/${encodeURIComponent(pipelineId)}`), token, body: null },
    PipelineSchema,
    "CircleCIPipeline",
  );
  return answer.ok ? { ok: true, status: answer.status, value: answer.value.vcs.revision } : answer;
};

export const pipelineLogUrl = (projectSlug: string, number: number): string =>
  `https://app.circleci.com/pipelines/${projectSlug}/${number}`;

const WebhookSchema = z.object({ id: z.string() });
const MessageSchema = z.object({ message: z.string() });

export const createWebhook = (
  fetcher: Fetch,
  api: string,
  token: string,
  hook: { projectId: string; url: string; signingSecret: string },
) =>
  callCircleCI(
    fetcher,
    {
      method: "POST",
      url: v2(api, "/webhook"),
      token,
      body: {
        name: "tumpel prebuild",
        events: ["workflow-completed"],
        url: hook.url,
        "verify-tls": true,
        "signing-secret": hook.signingSecret,
        scope: { id: hook.projectId, type: "project" },
      },
    },
    WebhookSchema,
    "CircleCIWebhook",
  );

export const deleteWebhook = (fetcher: Fetch, api: string, token: string, webhookId: string) =>
  callCircleCI(
    fetcher,
    { method: "DELETE", url: v2(api, `/webhook/${encodeURIComponent(webhookId)}`), token, body: null },
    MessageSchema,
    "CircleCIMessage",
  );

export const WorkflowCompletedSchema = z.object({
  type: z.string(),
  workflow: z.object({ name: z.string(), status: z.string(), url: z.string().url() }),
  pipeline: z.object({ id: z.string() }),
  project: z.object({ id: z.string() }),
});

export type WorkflowCompleted = z.infer<typeof WorkflowCompletedSchema>;

const hexBytes = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

export const verifyCircleCISignature = async (
  secret: string,
  body: ArrayBuffer,
  header: string | null,
): Promise<boolean> => {
  const signatures = (header ?? "")
    .split(",")
    .map((part) => /^v1=([0-9a-f]{64})$/.exec(part.trim())?.[1])
    .filter((hex): hex is string => hex !== undefined);
  if (signatures.length === 0) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  for (const hex of signatures) {
    if (await crypto.subtle.verify("HMAC", key, hexBytes(hex), body)) return true;
  }
  return false;
};
