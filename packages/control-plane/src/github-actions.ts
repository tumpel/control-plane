import { callGitHub, type Fetch, type GitHubAnswer, type GitHubRepository } from "./github.ts";
import { GitHubFileCommitSchema, GitHubFileSchema, GitHubWorkflowDispatchSchema } from "./github-schemas.ts";

export const REUSABLE_WORKFLOW_PATH = "tumpel/workflows/.github/workflows/prebuild.yml";
export const REUSABLE_WORKFLOW = `${REUSABLE_WORKFLOW_PATH}@v1`;
export const REUSABLE_WORKFLOW_TAGS = /^v1(?:\.\d+\.\d+)?$/;

export const DISPATCH_INPUTS: [string, string][] = [
  ["prebuildId", "The prebuild Tumpel started"],
  ["tenantId", "The tenant that started the prebuild"],
  ["apiOrigin", "The Tumpel API the upload job calls"],
  ["rootfsUrl", "A presigned GET of the guest image's root filesystem tar"],
  ["imageDigest", "The digest of the guest image the layer is built on"],
];

export const CALLER_WORKFLOW_EXAMPLE = [
  "name: tumpel prebuild",
  "",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  ...DISPATCH_INPUTS.flatMap(([name, description]) => [
    `      ${name}:`,
    `        description: ${description}`,
    "        required: true",
    "        type: string",
  ]),
  "",
  "permissions:",
  "  contents: read",
  "  id-token: write",
  "",
  "jobs:",
  "  prebuild:",
  `    uses: ${REUSABLE_WORKFLOW}`,
  "    with:",
  ...DISPATCH_INPUTS.map(([name]) => `      ${name}: \${{ inputs.${name} }}`),
  "",
].join("\n");

export interface PrebuildInputs {
  prebuildId: string;
  tenantId: string;
  apiOrigin: string;
  rootfsUrl: string;
  imageDigest: string;
}

export interface DispatchedRun {
  runId: number;
  htmlUrl: string;
}

const API_MEDIA_TYPE = "application/vnd.github+json";

const PERMISSION_LABELS: Record<string, string> = { actions: "Actions", contents: "Contents", workflows: "Workflows" };
const DISPATCH_PERMISSIONS = ["actions"];
const COMMIT_PERMISSIONS = ["contents", "workflows"];

export type CallerWorkflowSync =
  | { kind: "Current" }
  | { kind: "Committed"; commitSha: string; parentShas: string[] }
  | { kind: "PermissionMissing"; permissions: string[] }
  | { kind: "Refused"; detail: string };

type CallerFile = { kind: "Absent" } | { kind: "Current" } | { kind: "Stale"; blobSha: string };

const missingWrite = (granted: Record<string, string>, needed: string[]): string[] =>
  needed
    .filter((permission) => granted[permission] !== "write")
    .map((permission) => PERMISSION_LABELS[permission] ?? permission);

const repositoryPath = (target: GitHubRepository): string =>
  `${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`;

const contentsUrl = (api: string, target: GitHubRepository, path: string): string =>
  `${api}/repos/${repositoryPath(target)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64 = (text: string): string =>
  btoa(Array.from(encoder.encode(text), (byte) => String.fromCharCode(byte)).join(""));

const fromBase64 = (encoded: string): string =>
  decoder.decode(Uint8Array.from(atob(encoded.replace(/\s/g, "")), (char) => char.charCodeAt(0)));

const readCallerFile = async (
  fetcher: Fetch,
  api: string,
  token: string,
  target: GitHubRepository,
  location: { path: string; branch: string },
): Promise<GitHubAnswer<CallerFile>> => {
  const answer = await callGitHub(
    fetcher,
    {
      method: "GET",
      url: `${contentsUrl(api, target, location.path)}?ref=${encodeURIComponent(location.branch)}`,
      accept: API_MEDIA_TYPE,
      bearer: token,
      body: null,
    },
    GitHubFileSchema,
    "GitHubFile",
  );
  if (!answer.ok) return answer.status === 404 ? { ok: true, value: { kind: "Absent" } } : answer;
  if (fromBase64(answer.value.content) === CALLER_WORKFLOW_EXAMPLE) return { ok: true, value: { kind: "Current" } };
  return { ok: true, value: { kind: "Stale", blobSha: answer.value.sha } };
};

export const syncCallerWorkflow = async (
  fetcher: Fetch,
  api: string,
  minted: { token: string; permissions: Record<string, string> },
  target: GitHubRepository,
  location: { path: string; branch: string },
): Promise<CallerWorkflowSync> => {
  const file = await readCallerFile(fetcher, api, minted.token, target, location);
  if (!file.ok) return { kind: "Refused", detail: `${file.detail}, reading ${location.path}` };
  const needed =
    file.value.kind === "Current" ? DISPATCH_PERMISSIONS : [...DISPATCH_PERMISSIONS, ...COMMIT_PERMISSIONS];
  const missing = missingWrite(minted.permissions, needed);
  if (missing.length > 0) return { kind: "PermissionMissing", permissions: missing };
  if (file.value.kind === "Current") return { kind: "Current" };
  const committed = await callGitHub(
    fetcher,
    {
      method: "PUT",
      url: contentsUrl(api, target, location.path),
      accept: API_MEDIA_TYPE,
      bearer: minted.token,
      body: {
        message:
          file.value.kind === "Absent"
            ? "ci: add the tumpel prebuild workflow"
            : "ci: update the tumpel prebuild workflow",
        content: toBase64(CALLER_WORKFLOW_EXAMPLE),
        branch: location.branch,
        ...(file.value.kind === "Stale" ? { sha: file.value.blobSha } : {}),
      },
    },
    GitHubFileCommitSchema,
    "GitHubFileCommit",
  );
  if (!committed.ok) return { kind: "Refused", detail: `${committed.detail}, committing ${location.path}` };
  return {
    kind: "Committed",
    commitSha: committed.value.commit.sha,
    parentShas: committed.value.commit.parents.map((parent) => parent.sha),
  };
};

const workflowFile = (callerWorkflow: string): string => callerWorkflow.slice(callerWorkflow.lastIndexOf("/") + 1);

export const dispatchCallerWorkflow = async (
  fetcher: Fetch,
  api: string,
  token: string,
  target: GitHubRepository,
  dispatch: { callerWorkflow: string; ref: string; inputs: PrebuildInputs },
): Promise<GitHubAnswer<DispatchedRun>> => {
  const repository = repositoryPath(target);
  const answer = await callGitHub(
    fetcher,
    {
      method: "POST",
      url: `${api}/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile(dispatch.callerWorkflow))}/dispatches`,
      accept: API_MEDIA_TYPE,
      bearer: token,
      body: { ref: dispatch.ref, inputs: dispatch.inputs, return_run_details: true },
    },
    GitHubWorkflowDispatchSchema,
    "GitHubWorkflowDispatch",
  );
  return answer.ok
    ? { ok: true, value: { runId: answer.value.workflow_run_id, htmlUrl: answer.value.html_url } }
    : answer;
};

export interface RunEvent {
  action: string;
  runId: number;
  headSha: string;
  htmlUrl: string;
  conclusion: string | null;
}
