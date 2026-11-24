import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { updateDashboard } from "./dashboard-bot.mjs";
import { dashboardAssets } from "./dashboard-release.mjs";
import { githubApi } from "./release-github.mjs";

test("an orphaned bot branch gets a replacement PR whose failed auto-merge setup succeeds on retry", async (t) => {
  const scratch = fileURLToPath(new URL("../.tmp/", import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "dashboard-bot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "remote.git");
  const root = join(directory, "checkout");
  mkdirSync(root);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", remote);
  git("init", "-b", "main");
  git("config", "user.name", "release-test");
  git("config", "user.email", "release@example.test");
  git("remote", "add", "origin", remote);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "release-test", private: true, workspaces: ["packages/*"] }),
  );
  const lockSeed = { name: "release-test", lockfileVersion: 3, packages: {} };
  const release = { version: "0.10.0-rc.2", sha: "a".repeat(40), urls: dashboardAssets("0.10.0-rc.2"), integrity: {} };
  const cache = join(directory, "cache");
  writeFileSync(join(root, ".npmrc"), `cache=${cache}\noffline=true\n`);
  for (const [workspace, name, dependency] of [
    ["dashboard-site", "dashboard", "@tumpel/dashboard"],
    ["control-plane", "pages", "@tumpel/pages"],
  ]) {
    const workspacePath = join(root, "packages", workspace);
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(
      join(workspacePath, "package.json"),
      JSON.stringify({ name: workspace, dependencies: { [dependency]: dashboardAssets("0.9.0")[name] } }),
    );
    const packed = join(directory, name, "package");
    mkdirSync(packed, { recursive: true });
    writeFileSync(join(packed, "package.json"), JSON.stringify({ name: dependency, version: release.version }));
    const tarball = join(directory, `${name}.tgz`);
    execFileSync("tar", ["-czf", tarball, "-C", join(directory, name), "package"]);
    release.integrity[name] = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    execFileSync("npm", ["cache", "add", tarball, "--cache", cache], { cwd: root });
    lockSeed.packages[`node_modules/${dependency}`] = {
      version: release.version,
      resolved: release.urls[name],
      integrity: release.integrity[name],
    };
  }
  writeFileSync(join(root, "package-lock.json"), JSON.stringify(lockSeed));
  git("add", ".");
  git("commit", "-m", "chore: seed main");
  git("push", "origin", "main");
  git("switch", "-c", "bot/update-dashboard");
  for (const [workspace, name, dependency] of [
    ["dashboard-site", "dashboard", "@tumpel/dashboard"],
    ["control-plane", "pages", "@tumpel/pages"],
  ])
    writeFileSync(
      join(root, "packages", workspace, "package.json"),
      JSON.stringify({ name: workspace, dependencies: { [dependency]: dashboardAssets(release.version)[name] } }),
    );
  git("add", ".");
  git("commit", "-m", "fix(dashboard): seed orphaned update");
  const orphan = git("rev-parse", "HEAD");
  git("push", "origin", "bot/update-dashboard");
  git("switch", "main");
  const writes = [];
  let pull;
  const enableResults = [
    { errors: [{ message: "temporary auto-merge refusal" }] },
    { data: { enablePullRequestAutoMerge: { pullRequest: { number: 17 } } } },
  ];
  const github = githubApi("test-update", async (url, options) => {
    const path = new URL(url).pathname;
    if (!options.method) {
      assert.match(url, /pulls\?head=tumpel:bot\/update-dashboard&base=main&state=open$/);
      return Response.json(pull ? [pull] : []);
    }
    writes.push({ path, body: JSON.parse(options.body) });
    if (path === "/repos/tumpel/control-plane/pulls") {
      pull = { number: 17, node_id: "PR_17", auto_merge: null };
      return Response.json(pull);
    }
    if (path === "/repos/tumpel/control-plane/pulls/17") return Response.json(pull);
    assert.equal(path, "/graphql");
    assert.equal(JSON.parse(options.body).variables.pull, "PR_17");
    return Response.json(enableResults.shift());
  });

  await assert.rejects(updateDashboard({ root, token: "test-update", github, release }), /auto-merge failed/);

  const updated = git("ls-remote", "origin", "refs/heads/bot/update-dashboard").split(/\s/)[0];
  assert.notEqual(updated, orphan);
  const lock = JSON.parse(git("show", `${updated}:package-lock.json`));
  for (const name of ["dashboard", "pages"]) {
    assert.equal(lock.packages[`node_modules/@tumpel/${name}`].resolved, release.urls[name]);
    assert.equal(lock.packages[`node_modules/@tumpel/${name}`].integrity, release.integrity[name]);
  }
  assert.deepEqual(await updateDashboard({ root, token: "test-update", github, release }), { status: "pending" });
  assert.equal(git("ls-remote", "origin", "refs/heads/bot/update-dashboard").split(/\s/)[0], updated);
  assert.deepEqual(
    writes.map(({ path }) => path),
    ["/repos/tumpel/control-plane/pulls", "/graphql", "/repos/tumpel/control-plane/pulls/17", "/graphql"],
  );
  assert.equal(enableResults.length, 0);
  assert.equal(writes[0].body.head, "bot/update-dashboard");
  assert.equal(writes[0].body.base, "main");
  assert.match(writes[1].body.query, /enablePullRequestAutoMerge.*mergeMethod: SQUASH/);
  assert.match(writes[3].body.query, /enablePullRequestAutoMerge.*mergeMethod: SQUASH/);
  git("switch", "main");
  git("merge", "--ff-only", updated);
  git("push", "origin", "main");
  writes.length = 0;
  assert.deepEqual(await updateDashboard({ root, token: "test-update", github, release }), { status: "unchanged" });
  assert.deepEqual(writes, []);
});
