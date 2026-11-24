import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { updateDashboard } from "./dashboard-bot.mjs";
import { verifyDashboardRelease } from "./dashboard-release.mjs";
import { githubApi } from "./release-github.mjs";

const token = process.env.CONTROL_PLANE_UPDATE_TOKEN;
if (!token) {
  console.log("::notice::CONTROL_PLANE_UPDATE_TOKEN is empty; skipping dashboard dependency update.");
} else {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const github = githubApi(token);
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).client_payload;
  const download = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok)
      throw new Error(`Dashboard asset ${url} answered ${response.status}; finish publication before retrying.`);
    return Buffer.from(await response.arrayBuffer());
  };
  const release = await verifyDashboardRelease({ event, github, download });
  await updateDashboard({ root, token, github, release });
}
