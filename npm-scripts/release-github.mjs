import { setTimeout } from "node:timers/promises";

export const githubApi =
  (token, transport = fetch) =>
  async (path, options = {}) => {
    const response = await transport(`https://api.github.com${path}`, {
      ...options,
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...options.headers,
      },
      signal: AbortSignal.timeout(30_000),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!response.ok) throw new Error(`GitHub ${path} answered ${response.status}; check repository access and retry.`);
    if (response.status === 204) return null;
    return response.json();
  };

export const waitFor = async (observe, clock = { now: Date.now, sleep: setTimeout }) => {
  const started = clock.now();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await observe();
    if (result !== null) return result;
    if (attempt === 9)
      throw new Error(
        `Release readiness timed out after 10 observations (${clock.now() - started} ms); check the exact source SHA's checks and retry.`,
      );
    await clock.sleep(1000 * 2 ** attempt);
  }
};

export const exactChecks = async (github, repository, sha, clock) =>
  waitFor(async () => {
    const { workflow_runs: runs } = await github(
      `/repos/${repository}/actions/workflows/checks.yml/runs?head_sha=${sha}&event=push&per_page=100`,
    );
    const run = runs
      .filter((entry) => entry.head_sha === sha && entry.event === "push" && entry.head_branch === "main")
      .sort((a, b) => b.id - a.id)[0];
    if (run === undefined || run.status !== "completed") return null;
    if (run.conclusion !== "success")
      throw new Error(`Checks for ${repository}@${sha} ended ${run.conclusion}; fix that commit before releasing.`);
    return run;
  }, clock);
