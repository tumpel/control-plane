import { callGitHub, type Fetch, type GitHubAnswer, type GitHubRepository } from "./github.ts";
import { GitHubWorkflowDispatchSchema } from "./github-schemas.ts";

export const REUSABLE_WORKFLOW = "mvhenten/tumpel/.github/workflows/prebuild.yml@main";

const INPUTS: [string, string][] = [
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
  ...INPUTS.flatMap(([name, description]) => [
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
  ...INPUTS.map(([name]) => `      ${name}: \${{ inputs.${name} }}`),
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

const workflowFile = (callerWorkflow: string): string => callerWorkflow.slice(callerWorkflow.lastIndexOf("/") + 1);

export const dispatchCallerWorkflow = async (
  fetcher: Fetch,
  api: string,
  token: string,
  target: GitHubRepository,
  dispatch: { callerWorkflow: string; ref: string; inputs: PrebuildInputs },
): Promise<GitHubAnswer<DispatchedRun>> => {
  const repository = `${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`;
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

export type RunOutcome =
  | { kind: "Started" }
  | { kind: "Succeeded" }
  | { kind: "Failed"; conclusion: string }
  | { kind: "Pending" };

export const runOutcome = (event: RunEvent): RunOutcome => {
  if (event.action === "in_progress") return { kind: "Started" };
  if (event.action !== "completed") return { kind: "Pending" };
  if (event.conclusion === "success") return { kind: "Succeeded" };
  return { kind: "Failed", conclusion: event.conclusion ?? "without a conclusion" };
};
