import { fileURLToPath } from "node:url";
import { githubApi } from "./release-github.mjs";

export const dispatchDeploy = async ({ token, sha, event, ref, github, notice = console.log }) => {
  if (!token) {
    notice("::notice::DEPLOY_DISPATCH_TOKEN is empty; skipping component-released dispatch to deploy.");
    return { status: "skipped" };
  }
  if (event !== "push" || ref !== "refs/heads/main" || !/^[0-9a-f]{40}$/.test(sha))
    throw new Error("Deploy dispatch requires the checked main push SHA; run it after all checks pass.");
  await github("/repos/tumpel/deploy/dispatches", {
    method: "POST",
    body: {
      event_type: "component-released",
      client_payload: { component: "control-plane", repository: "tumpel/control-plane", sha },
    },
  });
  return { status: "dispatched" };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = process.env.DEPLOY_DISPATCH_TOKEN;
  await dispatchDeploy({
    token,
    sha: process.env.GITHUB_SHA,
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    github: githubApi(token),
  });
}
