import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardVersion } from "./dashboard-release.mjs";

const REPOSITORY = "tumpel/control-plane";
const BRANCH = "bot/update-dashboard";
const DEPENDENCIES = [
  ["packages/dashboard-site/package.json", "@tumpel/dashboard", "dashboard"],
  ["packages/control-plane/package.json", "@tumpel/pages", "pages"],
];

export const upsertDashboardPull = async (github, release, existing) => {
  const body = {
    title: `fix(dashboard): update dashboard and pages to ${release.version}`,
    body: `### What?\nUpdate dashboard and pages to ${release.version}.\n\n### Why?\nShip the published dashboard after its exact source checks pass.\n\n### How?\nVerify source ${release.sha} and both published checksums, then update both dependency URLs and their lock. Required checks and review govern squash auto-merge.\n\nRefs tumpel/deploy#37\nRefs tumpel/deploy#40\n`,
  };
  const pull = existing
    ? await github(`/repos/${REPOSITORY}/pulls/${existing.number}`, { method: "PATCH", body })
    : await github(`/repos/${REPOSITORY}/pulls`, { method: "POST", body: { ...body, head: BRANCH, base: "main" } });
  if (pull.auto_merge?.merge_method === "squash") return;
  const result = await github("/graphql", {
    method: "POST",
    body: {
      query:
        "mutation($pull: ID!) { enablePullRequestAutoMerge(input: {pullRequestId: $pull, mergeMethod: SQUASH}) { pullRequest { number } } }",
      variables: { pull: pull.node_id },
    },
  });
  if (result.errors?.length)
    throw new Error(
      `Dashboard auto-merge failed: ${JSON.stringify(result.errors)}; check required gates and token access.`,
    );
};

export const writeDashboardDependencies = (root, release) => {
  for (const [path, dependency, name] of DEPENDENCIES) {
    const manifest = JSON.parse(readFileSync(join(root, path), "utf8"));
    manifest.dependencies[dependency] = release.urls[name];
    writeFileSync(join(root, path), `${JSON.stringify(manifest, null, 2)}\n`);
  }
};

export const verifyDashboardLock = (lock, release) => {
  for (const [path, dependency, name] of DEPENDENCIES) {
    const entry = lock.packages[`node_modules/${dependency}`];
    if (
      lock.packages[path.replace("/package.json", "")].dependencies[dependency] !== release.urls[name] ||
      entry?.resolved !== release.urls[name] ||
      entry.version !== release.version ||
      entry.integrity !== release.integrity[name]
    )
      throw new Error(
        `Dashboard lock differs from verified ${name} bytes; regenerate the lock from the published release.`,
      );
  }
};

export const dashboardBot = ({ root, token, github }) => {
  const run = (command, args) =>
    execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: "", GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  const git = (...args) =>
    run("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", ...args]);
  const versionsAt = (ref) =>
    DEPENDENCIES.map(([path, dependency]) =>
      dashboardVersion(JSON.parse(git("show", `${ref}:${path}`)).dependencies[dependency]),
    );
  return {
    read: async () => {
      git("fetch", "origin", "main:refs/remotes/origin/main");
      const remote = git("ls-remote", "origin", `refs/heads/${BRANCH}`);
      const expected = remote.split(/\s/)[0];
      if (expected && !/^[0-9a-f]{40}$/.test(expected))
        throw new Error("Dashboard bot branch has an invalid SHA; inspect the remote branch.");
      const versions = [versionsAt("origin/main")];
      if (expected) {
        git("fetch", "origin", expected);
        versions.push(versionsAt(expected));
      }
      const pulls = await github(`/repos/${REPOSITORY}/pulls?head=tumpel:${BRANCH}&base=main&state=open`);
      if (pulls.length > 1) throw new Error("Multiple dashboard bot pull requests exist; retain one before retrying.");
      return { versions, expected, pull: pulls[0] };
    },
    update: async (release, state) => {
      git("switch", "--force-create", BRANCH, "origin/main");
      writeDashboardDependencies(root, release);
      run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
      verifyDashboardLock(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")), release);
      git("add", "--", ...DEPENDENCIES.map(([path]) => path), "package-lock.json");
      git(
        "-c",
        "user.name=dashboard-release[bot]",
        "-c",
        "user.email=dashboard-release[bot]@users.noreply.github.com",
        "commit",
        "-m",
        `fix(dashboard): update dashboard and pages to ${release.version}`,
      );
      git("push", `--force-with-lease=refs/heads/${BRANCH}:${state.expected}`, "origin", `HEAD:refs/heads/${BRANCH}`);
      await upsertDashboardPull(github, release, state.pull);
    },
  };
};
