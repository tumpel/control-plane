import { callGitHub, type Fetch, type GitHubAnswer, type GitHubRepository } from "./github.ts";
import { GitHubWorkflowDispatchSchema } from "./github-schemas.ts";

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
