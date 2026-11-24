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

export const exactChecks = async (github, repository, sha) => {
  const { workflow_runs: runs } = await github(
    `/repos/${repository}/actions/workflows/checks.yml/runs?head_sha=${sha}&event=push&per_page=100`,
  );
  const run = runs
    .filter((entry) => entry.head_sha === sha && entry.event === "push" && entry.head_branch === "main")
    .sort((a, b) => b.id - a.id)[0];
  if (run === undefined || run.status !== "completed" || run.conclusion !== "success")
    throw new Error(
      `Checks for ${repository}@${sha} have not completed successfully; dispatch only after that exact main SHA passes checks.`,
    );
  return run;
};
