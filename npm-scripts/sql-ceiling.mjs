import { execFileSync } from "node:child_process";

export const risen = (current, base) =>
  Object.entries(current)
    .map(([file, sites]) => ({ file, now: sites.length, before: (base[file] ?? []).length }))
    .filter(({ now, before }) => now > before);

export const baseRef = (env) => env.GITHUB_BASE_REF || "main";

export const baseAllowlist = (root, allowlist, env) => {
  const ref = baseRef(env);
  if (env.GITHUB_ACTIONS) {
    execFileSync("git", ["fetch", "--depth", "1", "origin", `+refs/heads/${ref}:refs/remotes/origin/${ref}`], {
      cwd: root,
      stdio: "inherit",
    });
  }
  const text = execFileSync("git", ["show", `origin/${ref}:${allowlist}`], { cwd: root, encoding: "utf8" });
  return JSON.parse(text).sites ?? {};
};
