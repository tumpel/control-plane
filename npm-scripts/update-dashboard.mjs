import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dashboardBot } from "./dashboard-bot.mjs";
import { updateDashboard } from "./dashboard-release.mjs";
import { githubApi } from "./release-github.mjs";

const token = process.env.CONTROL_PLANE_UPDATE_TOKEN;
if (!token) {
  await updateDashboard({ token });
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
  await updateDashboard({ token, event, github, download, bot: dashboardBot({ root, token, github }) });
}
