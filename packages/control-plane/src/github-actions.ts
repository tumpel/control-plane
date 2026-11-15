import { z } from "zod";
import { callGitHub, type Fetch, GITHUB_WEB, type GitHubAnswer, type GitHubRepository } from "./github.ts";
import { GitHubFileCommitSchema, GitHubFileSchema } from "./github-schemas.ts";

export const REUSABLE_WORKFLOW_PATH = "tumpel/workflows/.github/workflows/prebuild.yml";
export const REUSABLE_WORKFLOW = `${REUSABLE_WORKFLOW_PATH}@v2`;
export const REUSABLE_WORKFLOW_TAGS = /^v2(?:\.\d+\.\d+)?$/;
export const DEFAULT_CALLER_WORKFLOW = ".github/workflows/tumpel-prebuild.yml";
export const RUN_EVENTS = ["push", "workflow_dispatch"];

export interface CallerWorkflowOf {
  path: string;
  apiOrigin: string;
}

export const callerWorkflowExample = (caller: CallerWorkflowOf): string =>
  [
    "name: tumpel prebuild",
    "",
    "on:",
    "  push:",
    "    paths:",
    `      - ${caller.path}`,
    "  workflow_dispatch:",
    "",
    "permissions:",
    "  contents: read",
    "  id-token: write",
    "",
    "jobs:",
    "  prebuild:",
    `    uses: ${REUSABLE_WORKFLOW}`,
    "    with:",
    `      apiOrigin: ${caller.apiOrigin}`,
    "",
  ].join("\n");

const API_MEDIA_TYPE = "application/vnd.github+json";

const PERMISSION_LABELS: Record<string, string> = { actions: "Actions", contents: "Contents", workflows: "Workflows" };
const DISPATCH_PERMISSIONS = ["actions"];
const COMMIT_PERMISSIONS = ["contents", "workflows"];
const ACTIONS_DISABLED = /disabled/i;

export type CallerWorkflowSync =
  | { kind: "Current" }
  | { kind: "Committed"; commitSha: string }
  | { kind: "PermissionMissing"; permissions: string[] }
  | { kind: "Refused"; detail: string };

export type Dispatched =
  | { kind: "Dispatched" }
  | { kind: "ActionsDisabled"; detail: string }
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
  location: { path: string; branch: string; example: string },
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
  if (fromBase64(answer.value.content) === location.example) return { ok: true, value: { kind: "Current" } };
  return { ok: true, value: { kind: "Stale", blobSha: answer.value.sha } };
};

export const syncCallerWorkflow = async (
  fetcher: Fetch,
  api: string,
  minted: { token: string; permissions: Record<string, string> },
  target: GitHubRepository,
  caller: CallerWorkflowOf & { branch: string },
): Promise<CallerWorkflowSync> => {
  const example = callerWorkflowExample(caller);
  const file = await readCallerFile(fetcher, api, minted.token, target, { ...caller, example });
  if (!file.ok) return { kind: "Refused", detail: `${file.detail}, reading ${caller.path}` };
  const needed =
    file.value.kind === "Current" ? DISPATCH_PERMISSIONS : [...DISPATCH_PERMISSIONS, ...COMMIT_PERMISSIONS];
  const missing = missingWrite(minted.permissions, needed);
  if (missing.length > 0) return { kind: "PermissionMissing", permissions: missing };
  if (file.value.kind === "Current") return { kind: "Current" };
  const committed = await callGitHub(
    fetcher,
    {
      method: "PUT",
      url: contentsUrl(api, target, caller.path),
      accept: API_MEDIA_TYPE,
      bearer: minted.token,
      body: {
        message:
          file.value.kind === "Absent"
            ? "ci: add the tumpel prebuild workflow"
            : "ci: update the tumpel prebuild workflow",
        content: toBase64(example),
        branch: caller.branch,
        ...(file.value.kind === "Stale" ? { sha: file.value.blobSha } : {}),
      },
    },
    GitHubFileCommitSchema,
    "GitHubFileCommit",
  );
  if (!committed.ok) return { kind: "Refused", detail: `${committed.detail}, committing ${caller.path}` };
  return { kind: "Committed", commitSha: committed.value.commit.sha };
};

const workflowFile = (callerWorkflow: string): string => callerWorkflow.slice(callerWorkflow.lastIndexOf("/") + 1);

export const workflowPage = (target: GitHubRepository, callerWorkflow: string): string =>
  `${GITHUB_WEB}/${repositoryPath(target)}/actions/workflows/${encodeURIComponent(workflowFile(callerWorkflow))}`;

export const runPage = (repository: string, runId: number): string => `${repository}/actions/runs/${runId}`;

export const dispatchCallerWorkflow = async (
  fetcher: Fetch,
  api: string,
  token: string,
  target: GitHubRepository,
  dispatch: { callerWorkflow: string; ref: string },
): Promise<Dispatched> => {
  const answer = await callGitHub(
    fetcher,
    {
      method: "POST",
      url: `${api}/repos/${repositoryPath(target)}/actions/workflows/${encodeURIComponent(workflowFile(dispatch.callerWorkflow))}/dispatches`,
      accept: API_MEDIA_TYPE,
      bearer: token,
      body: { ref: dispatch.ref },
    },
    z.null(),
    "empty answer",
  );
  if (answer.ok) return { kind: "Dispatched" };
  const detail = `${answer.detail}, dispatching ${dispatch.callerWorkflow} of ${target.owner}/${target.name}`;
  const disabled = (answer.status === 403 || answer.status === 422) && ACTIONS_DISABLED.test(answer.detail);
  return disabled ? { kind: "ActionsDisabled", detail } : { kind: "Refused", detail };
};

export interface RunEvent {
  action: string;
  runId: number;
  repository: string;
  path: string;
  headSha: string;
  htmlUrl: string;
  conclusion: string | null;
}
