import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { upsertDashboardPull, verifyDashboardLock, writeDashboardDependencies } from "./dashboard-bot.mjs";
import { compareVersions, dashboardAssets, updateDashboard } from "./dashboard-release.mjs";
import { dispatchDeploy } from "./dispatch-deploy.mjs";
import { exactChecks, githubApi, waitFor } from "./release-github.mjs";

const evidenceApi = ({ sha, tag, checks, assets, tagSha = sha, writes = [] }) =>
  githubApi("test-update", async (url, options) => {
    assert.equal(options.headers.authorization, "Bearer test-update");
    const path = new URL(url).pathname;
    if (options.method) {
      writes.push({ path, method: options.method, body: JSON.parse(options.body) });
      if (path === "/graphql")
        return Response.json({ data: { enablePullRequestAutoMerge: { pullRequest: { number: 17 } } } });
      return Response.json({ number: 17, node_id: "PR_17", auto_merge: null });
    }
    if (path === `/repos/tumpel/dashboard/commits/${tag}`) return Response.json({ sha: tagSha });
    if (path === `/repos/tumpel/dashboard/compare/${sha}...main`) return Response.json({ status: "ahead" });
    if (path === `/repos/tumpel/dashboard/releases/tags/${tag}`)
      return Response.json({
        draft: false,
        target_commitish: sha,
        tag_name: tag,
        published_at: "2026-11-23T20:00:00Z",
        assets: assets.map((url) => ({ browser_download_url: url, state: "uploaded" })),
      });
    if (path === "/repos/tumpel/dashboard/actions/workflows/checks.yml/runs") {
      assert.equal(new URL(url).searchParams.get("head_sha"), sha);
      return Response.json({ workflow_runs: checks });
    }
    assert.fail(`Unexpected GitHub request: ${url}`);
  });

const downloads = (urls, bytes, checksums) => async (url) => {
  for (const [name, tarball] of Object.entries(urls)) {
    if (url === tarball) return bytes[name];
    if (url === `${tarball}.sha256`) return Buffer.from(checksums[name]);
  }
  assert.fail(`Unexpected asset: ${url}`);
};

const fakeClock = () => {
  let now = 0;
  const sleeps = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
};

for (const existing of [undefined, { number: 17 }]) {
  test(`a verified release ${existing ? "updates" : "opens"} one bot PR with exact URLs and squash auto-merge`, async (t) => {
    const sha = "a".repeat(40);
    const tag = "v0.10.0-rc.2";
    const urls = dashboardAssets("0.10.0-rc.2");
    const bytes = { dashboard: Buffer.from("dashboard B"), pages: Buffer.from("pages B") };
    const checksums = {
      dashboard: `${createHash("sha256").update(bytes.dashboard).digest("hex")}  dashboard-0.10.0-rc.2.tgz\n`,
      pages: `${createHash("sha256").update(bytes.pages).digest("hex")}  pages-0.10.0-rc.2.tgz\n`,
    };
    const assets = Object.values(urls).flatMap((url) => [url, `${url}.sha256`]);
    const writes = [];
    const checks = [
      { id: 7, head_sha: sha, event: "push", head_branch: "main", status: "completed", conclusion: "success" },
    ];
    const github = evidenceApi({ sha, tag, checks, assets, writes });
    const root = mkdtempSync(join(tmpdir(), "dashboard-update-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [directory, dependency] of [
      ["dashboard-site", "@tumpel/dashboard"],
      ["control-plane", "@tumpel/pages"],
    ]) {
      mkdirSync(join(root, "packages", directory), { recursive: true });
      writeFileSync(
        join(root, "packages", directory, "package.json"),
        JSON.stringify({ dependencies: { [dependency]: "old", other: "1.0.0" } }),
      );
    }
    let updates = 0;
    const result = await updateDashboard({
      token: "test-update",
      event: { component: "dashboard", repository: "tumpel/dashboard", sha, tag, assets },
      github,
      download: downloads(urls, bytes, checksums),
      bot: {
        read: async () => ({ versions: [["0.9.0", "0.7.0"]], pull: existing }),
        update: async (release, state) => {
          updates += 1;
          writeDashboardDependencies(root, release);
          await upsertDashboardPull(github, release, state.pull);
        },
      },
    });
    assert.deepEqual(result, { status: "updated" });
    assert.equal(updates, 1);
    const dashboard = JSON.parse(readFileSync(join(root, "packages/dashboard-site/package.json"), "utf8"));
    const pages = JSON.parse(readFileSync(join(root, "packages/control-plane/package.json"), "utf8"));
    assert.deepEqual(dashboard.dependencies, {
      "@tumpel/dashboard":
        "https://github.com/tumpel/dashboard/releases/download/v0.10.0-rc.2/dashboard-0.10.0-rc.2.tgz",
      other: "1.0.0",
    });
    assert.deepEqual(pages.dependencies, {
      "@tumpel/pages": "https://github.com/tumpel/dashboard/releases/download/v0.10.0-rc.2/pages-0.10.0-rc.2.tgz",
      other: "1.0.0",
    });
    assert.equal(writes.length, 2);
    assert.equal(writes[0].method, existing ? "PATCH" : "POST");
    assert.equal(writes[0].path, `/repos/tumpel/control-plane/pulls${existing ? "/17" : ""}`);
    if (!existing) {
      assert.equal(writes[0].body.head, "bot/update-dashboard");
      assert.equal(writes[0].body.base, "main");
    }
    assert.match(writes[0].body.body, new RegExp(sha));
    assert.equal(writes[1].path, "/graphql");
    assert.match(writes[1].body.query, /enablePullRequestAutoMerge.*mergeMethod: SQUASH/);
    assert.deepEqual(writes[1].body.variables, { pull: "PR_17" });
  });
}

test("duplicate and older releases preserve both main and the newer pending bot PR", async () => {
  const sha = "b".repeat(40);
  const tag = "v0.10.0-rc.2";
  const urls = dashboardAssets("0.10.0-rc.2");
  const bytes = { dashboard: Buffer.from("dashboard B"), pages: Buffer.from("pages B") };
  const checksums = {
    dashboard: `${createHash("sha256").update(bytes.dashboard).digest("hex")}  dashboard-0.10.0-rc.2.tgz`,
    pages: `${createHash("sha256").update(bytes.pages).digest("hex")}  pages-0.10.0-rc.2.tgz`,
  };
  const assets = Object.values(urls).flatMap((url) => [url, `${url}.sha256`]);
  const checks = [
    { id: 8, head_sha: sha, event: "push", head_branch: "main", status: "completed", conclusion: "success" },
  ];
  const writes = [];
  for (const versions of [
    [["0.10.0-rc.2", "0.10.0-rc.2"]],
    [
      ["0.9.0", "0.7.0"],
      ["0.10.0-rc.3", "0.10.0-rc.3"],
    ],
    [
      ["0.9.0", "0.7.0"],
      ["0.10.0-rc.2", "0.10.0-rc.2"],
    ],
  ]) {
    const result = await updateDashboard({
      token: "test-update",
      event: { component: "dashboard", repository: "tumpel/dashboard", sha, tag, assets },
      github: evidenceApi({ sha, tag, checks, assets, writes }),
      download: downloads(urls, bytes, checksums),
      bot: { read: async () => ({ versions }), update: async () => assert.fail("A stale event wrote dependencies") },
    });
    assert.deepEqual(result, { status: "unchanged" });
  }
  assert.deepEqual(writes, []);
  assert.equal(compareVersions("0.10.0", "0.10.0-rc.100"), 1);
  assert.equal(compareVersions("0.10.0-rc.10", "0.10.0-rc.9"), 1);
});

test("bad checksums and a tag naming another commit refuse before a bot write", async () => {
  const sha = "c".repeat(40);
  const tag = "v0.10.0-rc.4";
  const urls = dashboardAssets("0.10.0-rc.4");
  const bytes = { dashboard: Buffer.from("tampered"), pages: Buffer.from("pages") };
  const checksums = {
    dashboard: `${"0".repeat(64)}  dashboard-0.10.0-rc.4.tgz`,
    pages: `${"0".repeat(64)}  pages-0.10.0-rc.4.tgz`,
  };
  const assets = Object.values(urls).flatMap((url) => [url, `${url}.sha256`]);
  const checks = [
    { id: 9, head_sha: sha, event: "push", head_branch: "main", status: "completed", conclusion: "success" },
  ];
  for (const [tagSha, message] of [
    [sha, /checksum failed/],
    ["d".repeat(40), /tag differs/],
  ]) {
    await assert.rejects(
      updateDashboard({
        token: "test-update",
        event: { component: "dashboard", repository: "tumpel/dashboard", sha, tag, assets },
        github: evidenceApi({ sha, tag, checks, assets, tagSha }),
        download: downloads(urls, bytes, checksums),
        bot: { read: async () => assert.fail("Invalid provenance reached the bot") },
      }),
      message,
    );
  }
});

test("historical green checks never substitute for missing exact-SHA checks", async () => {
  const sha = "e".repeat(40);
  const tag = "v0.10.0-rc.5";
  const urls = dashboardAssets("0.10.0-rc.5");
  const assets = Object.values(urls).flatMap((url) => [url, `${url}.sha256`]);
  const checks = [
    {
      id: 10,
      head_sha: "f".repeat(40),
      event: "push",
      head_branch: "main",
      status: "completed",
      conclusion: "success",
    },
  ];
  const clock = fakeClock();
  let observations = 0;
  const github = evidenceApi({ sha, tag, checks, assets });
  await assert.rejects(
    updateDashboard({
      token: "test-update",
      event: { component: "dashboard", repository: "tumpel/dashboard", sha, tag, assets },
      github: async (path, options) => {
        if (path.includes("/runs?")) observations += 1;
        return github(path, options);
      },
      clock,
      download: async () => assert.fail("Unchecked assets downloaded"),
      bot: { read: async () => assert.fail("Unchecked commit reached the bot") },
    }),
    /timed out after 10 observations/,
  );
  assert.equal(observations, 10);
  assert.deepEqual(clock.sleeps, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000]);
  assert.equal(clock.now(), 511000);
});

test("the wait observes ten times, sleeps nine times, and accepts success on observation ten", async () => {
  const clock = fakeClock();
  let observations = 0;
  assert.equal(await waitFor(async () => (++observations === 10 ? "ready" : null), clock), "ready");
  assert.equal(observations, 10);
  assert.deepEqual(clock.sleeps, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000]);
});

test("failed checks and authentication errors abort on the first observation", async () => {
  const sha = "1".repeat(40);
  const tag = "v0.10.0-rc.6";
  const checks = [
    { id: 12, head_sha: sha, event: "push", head_branch: "main", status: "completed", conclusion: "failure" },
    { id: 11, head_sha: sha, event: "push", head_branch: "main", status: "completed", conclusion: "success" },
  ];
  const clock = fakeClock();
  await assert.rejects(
    exactChecks(evidenceApi({ sha, tag, checks, assets: [] }), "tumpel/dashboard", sha, clock),
    /ended failure/,
  );
  for (const status of [401, 403, 500]) {
    let observations = 0;
    const github = githubApi("test-update", async () => {
      observations += 1;
      return new Response("failed", { status });
    });
    await assert.rejects(exactChecks(github, "tumpel/dashboard", sha, clock), new RegExp(`answered ${status}`));
    assert.equal(observations, 1);
  }
  assert.deepEqual(clock.sleeps, []);
});

test("empty secrets skip both entry points despite other token variables", async () => {
  const notices = [];
  assert.deepEqual(await updateDashboard({ token: "", notice: (line) => notices.push(line) }), { status: "skipped" });
  assert.deepEqual(await dispatchDeploy({ token: "", notice: (line) => notices.push(line) }), { status: "skipped" });
  assert.equal(notices.length, 2);
  for (const script of ["update-dashboard", "dispatch-deploy"]) {
    const output = execFileSync(process.execPath, [`npm-scripts/${script}.mjs`], {
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
