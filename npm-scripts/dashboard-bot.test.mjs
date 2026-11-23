import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { updateDashboard } from "./dashboard-bot.mjs";
import { dashboardAssets } from "./dashboard-release.mjs";
import { githubApi } from "./release-github.mjs";

test("a closed bot PR leaves an orphan branch that the concrete updater replaces with a new PR", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dashboard-bot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const server = new Worker(
    `const { createServer } = require("node:http");
     const { readFileSync } = require("node:fs");
     const { workerData, parentPort } = require("node:worker_threads");
     createServer((request, response) => response.end(readFileSync(workerData + request.url)))
       .listen(0, "127.0.0.1", function () { parentPort.postMessage(this.address().port); });`,
    { eval: true, workerData: directory },
  );
  t.after(() => server.terminate());
  const [port] = await once(server, "message");
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
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({ name: "release-test", lockfileVersion: 3, packages: {} }),
  );
  const release = { version: "0.10.0-rc.2", sha: "a".repeat(40), urls: {}, integrity: {} };
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
    release.urls[name] = `http://127.0.0.1:${port}/${name}.tgz`;
    release.integrity[name] = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  }
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
  const github = githubApi("test-update", async (url, options) => {
    const path = new URL(url).pathname;
    if (!options.method) {
      assert.match(url, /pulls\?head=tumpel:bot\/update-dashboard&base=main&state=open$/);
      return Response.json([]);
    }
    writes.push({ path, body: JSON.parse(options.body) });
    if (path === "/repos/tumpel/control-plane/pulls") return Response.json({ number: 17, node_id: "PR_17" });
    assert.equal(path, "/graphql");
    return Response.json({ data: { enablePullRequestAutoMerge: { pullRequest: { number: 17 } } } });
  });

  assert.deepEqual(await updateDashboard({ root, token: "test-update", github, release }), { status: "updated" });

  const updated = git("ls-remote", "origin", "refs/heads/bot/update-dashboard").split(/\s/)[0];
  assert.notEqual(updated, orphan);
  const lock = JSON.parse(git("show", `${updated}:package-lock.json`));
  for (const name of ["dashboard", "pages"]) {
    assert.equal(lock.packages[`node_modules/@tumpel/${name}`].resolved, release.urls[name]);
    assert.equal(lock.packages[`node_modules/@tumpel/${name}`].integrity, release.integrity[name]);
  }
  assert.equal(writes.length, 2);
  assert.equal(writes[0].body.head, "bot/update-dashboard");
  assert.equal(writes[0].body.base, "main");
  assert.match(writes[1].body.query, /enablePullRequestAutoMerge.*mergeMethod: SQUASH/);
});
