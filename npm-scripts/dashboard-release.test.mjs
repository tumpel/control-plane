import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyDashboardLock } from "./dashboard-bot.mjs";
import {
  compareVersions,
  dashboardAssets,
  dashboardIntegrity,
  dashboardReleaseEvent,
  releaseNeedsUpdate,
  verifyDashboardProvenance,
} from "./dashboard-release.mjs";
import { dispatchDeploy } from "./dispatch-deploy.mjs";
import { exactChecks, githubApi } from "./release-github.mjs";

test("published dashboard tags resolve to the checked main commit even when target_commitish is main", () => {
  const sha = "a".repeat(40);
  const urls = dashboardAssets("0.10.0-rc.2");
  const assets = Object.values(urls).flatMap((url) => [url, `${url}.sha256`]);
  const event = { component: "dashboard", repository: "tumpel/dashboard", sha, tag: "v0.10.0-rc.2", assets };
  const release = dashboardReleaseEvent(event);
  const evidence = {
    commit: { sha },
    ancestry: { status: "ahead" },
    published: {
      draft: false,
      target_commitish: "main",
      tag_name: event.tag,
      published_at: "2026-11-23T20:00:00Z",
      assets: assets.map((url) => ({ browser_download_url: url, state: "uploaded" })),
    },
  };
  verifyDashboardProvenance(release, evidence);
  assert.throws(
    () => verifyDashboardProvenance(release, { ...evidence, commit: { sha: "b".repeat(40) } }),
    /tag differs/,
  );
  assert.throws(
    () => verifyDashboardProvenance(release, { ...evidence, ancestry: { status: "diverged" } }),
    /outside main/,
  );
  for (const published of [
    { ...evidence.published, draft: true },
    { ...evidence.published, published_at: null },
    { ...evidence.published, tag_name: "v0.9.0" },
  ])
    assert.throws(() => verifyDashboardProvenance(release, { ...evidence, published }), /unpublished/);
  assert.throws(
    () => verifyDashboardProvenance(release, { ...evidence, published: { ...evidence.published, assets: [] } }),
    /lacks/,
  );
  for (const change of [
    { component: "other" },
    { repository: "other/dashboard" },
    { sha: "short" },
    { tag: "vbad" },
    { assets: [] },
  ])
    assert.throws(() => dashboardReleaseEvent({ ...event, ...change }), /provenance|assets differ/);
});

test("stale and duplicate releases preserve installed versions while partial updates finish", () => {
  const release = { version: "0.10.0-rc.2" };
  assert.equal(releaseNeedsUpdate(release, ["0.9.0", "0.7.0"]), true);
  assert.equal(releaseNeedsUpdate(release, ["0.10.0-rc.2", "0.10.0-rc.2"]), false);
  assert.equal(releaseNeedsUpdate(release, ["0.10.0-rc.3", "0.10.0-rc.3"]), false);
  assert.equal(releaseNeedsUpdate(release, ["0.10.0-rc.2", "0.7.0"]), true);
  assert.equal(releaseNeedsUpdate(release, ["0.10.0-rc.3", "0.7.0"]), false);
  assert.equal(compareVersions("0.10.0", "0.10.0-rc.100"), 1);
  assert.equal(compareVersions("0.10.0-rc.10", "0.10.0-rc.9"), 1);
});

test("checksums bind the exact published bytes and filename", () => {
  const url = dashboardAssets("0.10.0-rc.2").dashboard;
  const bytes = Buffer.from("dashboard B");
  const checksum = `${createHash("sha256").update(bytes).digest("hex")}  dashboard-0.10.0-rc.2.tgz\n`;
  assert.equal(
    dashboardIntegrity(url, bytes, checksum),
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  );
  assert.throws(() => dashboardIntegrity(url, Buffer.from("tampered"), checksum), /checksum failed/);
  assert.throws(() => dashboardIntegrity(url, bytes, checksum.replace("dashboard-", "other-")), /checksum failed/);
});

test("dispatch provenance requires successful checks for the exact main push SHA", async () => {
  const sha = "e".repeat(40);
  const success = {
    id: 1,
    head_sha: sha,
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  };
  const github = githubApi("test-update", async (url) => {
    assert.equal(
      url,
      `https://api.github.com/repos/tumpel/dashboard/actions/workflows/checks.yml/runs?head_sha=${sha}&event=push&per_page=100`,
    );
    return Response.json({ workflow_runs: [success] });
  });
  assert.deepEqual(await exactChecks(github, "tumpel/dashboard", sha), success);
  for (const runs of [
    [],
    [{ ...success, head_sha: "f".repeat(40) }],
    [{ ...success, event: "pull_request" }],
    [{ ...success, head_branch: "feature" }],
    [{ ...success, status: "in_progress", conclusion: null }],
    [{ ...success, id: 2, conclusion: "failure" }, success],
  ])
    await assert.rejects(
      exactChecks(async () => ({ workflow_runs: runs }), "tumpel/dashboard", sha),
      /dispatch only after that exact main SHA passes checks/,
    );
});

test("authentication and transport errors abort provenance verification", async () => {
  const sha = "1".repeat(40);
  for (const status of [401, 403, 500]) {
    const github = githubApi("test-update", async () => new Response("failed", { status }));
    await assert.rejects(exactChecks(github, "tumpel/dashboard", sha), new RegExp(`answered ${status}`));
  }
});

test("empty secrets skip both entry points despite other token variables", async () => {
  const notices = [];
  assert.deepEqual(await dispatchDeploy({ token: "", notice: (line) => notices.push(line) }), { status: "skipped" });
  assert.equal(notices.length, 1);
  for (const script of ["update-dashboard", "dispatch-deploy"]) {
    const output = execFileSync("npm", ["run", `release:${script}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONTROL_PLANE_UPDATE_TOKEN: "",
        DEPLOY_DISPATCH_TOKEN: "",
        GITHUB_TOKEN: "must-not-be-used",
        GH_TOKEN: "must-not-be-used",
        GITHUB_EVENT_PATH: "/does-not-exist",
      },
    });
    assert.match(output, /::notice::.*is empty; skipping/);
  }
});

test("deploy dispatch carries the exact checked main SHA and rejects other events", async () => {
  const sha = "2".repeat(40);
  const writes = [];
  const github = async (path, options) => writes.push({ path, ...options });
  assert.deepEqual(
    await dispatchDeploy({ token: "test-dispatch", sha, event: "push", ref: "refs/heads/main", github }),
    { status: "dispatched" },
  );
  assert.deepEqual(writes, [
    {
      path: "/repos/tumpel/deploy/dispatches",
      method: "POST",
      body: {
        event_type: "component-released",
        client_payload: { component: "control-plane", repository: "tumpel/control-plane", sha },
      },
    },
  ]);
  for (const [event, ref] of [
    ["pull_request", "refs/heads/main"],
    ["push", "refs/heads/feature"],
  ])
    await assert.rejects(
      dispatchDeploy({ token: "test-dispatch", sha, event, ref, github }),
      /requires the checked main push SHA/,
    );
  assert.equal(writes.length, 1);
});

test("the lock must name both exact published URLs and verified tarball integrities", () => {
  const release = {
    version: "0.10.0-rc.7",
    urls: dashboardAssets("0.10.0-rc.7"),
    integrity: {
      dashboard: `sha512-${createHash("sha512").update("dashboard B").digest("base64")}`,
      pages: `sha512-${createHash("sha512").update("pages B").digest("base64")}`,
    },
  };
  const lock = {
    packages: {
      "packages/dashboard-site": { dependencies: { "@tumpel/dashboard": release.urls.dashboard } },
      "packages/control-plane": { dependencies: { "@tumpel/pages": release.urls.pages } },
      "node_modules/@tumpel/dashboard": {
        version: release.version,
        resolved: release.urls.dashboard,
        integrity: release.integrity.dashboard,
      },
      "node_modules/@tumpel/pages": {
        version: release.version,
        resolved: release.urls.pages,
        integrity: release.integrity.pages,
      },
    },
  };
  verifyDashboardLock(lock, release);
  lock.packages["node_modules/@tumpel/pages"].integrity = "sha512-tampered";
  assert.throws(() => verifyDashboardLock(lock, release), /lock differs from verified pages bytes/);
});
