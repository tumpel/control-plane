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

export const CIRCLECI_CONFIG_EXAMPLE = [
  "version: 2.1",
  "orbs:",
  `  tumpel: ${CIRCLECI_ORB}`,
  "parameters:",
  ...CIRCLECI_PARAMETERS.map((name) => `  ${name}: { type: string, default: "" }`),
  "workflows:",
  "  tumpel-prebuild:",
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

export type CircleCIAnswer<T> = { ok: true; value: T } | { ok: false; status: number; detail: string };

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
  if (parsed.success) return { ok: true, value: parsed.data };
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
