import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { githubApi } from "./release-github.mjs";

export const dispatchDeploy = async ({ token, event, run, github, notice = console.log }) => {
  if (!token) {
    notice("::notice::DEPLOY_DISPATCH_TOKEN is empty; skipping component-released dispatch to deploy.");
    return { status: "skipped" };
  }
  if (
    event !== "workflow_run" ||
    run.name !== "checks" ||
    run.event !== "push" ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !/^[0-9a-f]{40}$/.test(run.head_sha)
  )
    throw new Error("Deploy dispatch requires completed successful checks for a main push SHA.");
  await github("/repos/tumpel/deploy/dispatches", {
    method: "POST",
    body: {
      event_type: "component-released",
      client_payload: { component: "control-plane", repository: "tumpel/control-plane", sha: run.head_sha },
    },
  });
  return { status: "dispatched" };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = process.env.DEPLOY_DISPATCH_TOKEN;
  await dispatchDeploy({
    token,
    event: process.env.GITHUB_EVENT_NAME,
    run: token ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).workflow_run : undefined,
    github: githubApi(token),
  });
}
