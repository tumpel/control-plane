import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fetch } from "../src/github.ts";
import type { PrebuildTemplateVersion } from "../src/template-catalog.ts";
import { openTemplatePullRequest, readTemplatePullRequest } from "../src/template-pull-request.ts";

const API = "https://api.github.test";
const TARGET = { owner: "acme", name: "app" };
const HEAD = "1".repeat(40);
const ROOT = "2".repeat(40);
const TREE = "3".repeat(40);
const COMMIT = "4".repeat(40);
const TEMPLATE: PrebuildTemplateVersion = {
  prebuildTemplateId: "npm",
  prebuildTemplateVersion: 1,
  summary: "Installs the npm dependencies with npm ci.",
  installs: [],
  toolchains: [{ toolchain: "Node", toolchainVersion: "26.13.1" }],
  digest: "a".repeat(64),
  devcontainer: '{ "onCreateCommand": "npm ci" }\n',
};

type Answer = { status: number; body: unknown };
type Call = { method: string; path: string; body: unknown };

const PULL = { number: 12, html_url: "https://github.com/acme/app/pull/12", state: "open", merged_at: null };

const github = (root: unknown[], overrides: Record<string, Answer> = {}) => {
  const calls: Call[] = [];
  const answers: Record<string, Answer> = {
    "GET /repos/acme/app": { status: 200, body: { default_branch: "trunk" } },
    "GET /repos/acme/app/commits/trunk": { status: 200, body: { sha: HEAD, commit: { tree: { sha: ROOT } } } },
    [`GET /repos/acme/app/git/trees/${ROOT}`]: { status: 200, body: { tree: root } },
    "GET /repos/acme/app/git/trees/d1?recursive=1": {
      status: 200,
      body: { tree: [{ path: "devcontainer.json", type: "blob", sha: "b1" }] },
    },
    "POST /repos/acme/app/git/trees": { status: 201, body: { sha: TREE } },
    "POST /repos/acme/app/git/commits": { status: 201, body: { sha: COMMIT } },
    "GET /repos/acme/app/git/ref/heads/tumpel/prebuild-template": { status: 404, body: { message: "Not Found" } },
    "POST /repos/acme/app/git/refs": { status: 201, body: { object: { sha: COMMIT } } },
    "GET /repos/acme/app/pulls?head=acme%3Atumpel%2Fprebuild-template&state=open&sort=created&direction=desc&per_page=1":
      { status: 200, body: [] },
    "POST /repos/acme/app/pulls": { status: 201, body: PULL },
    ...overrides,
  };
  const fetcher: Fetch = async (url, init) => {
    const path = url.slice(API.length);
    const method = init.method ?? "GET";
    calls.push({ method, path, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    const answer = answers[`${method} ${path}`];
    if (answer === undefined) return Response.json({ message: `unexpected ${method} ${path}` }, { status: 500 });
    return Response.json(answer.body, { status: answer.status });
  };
  return { fetcher, calls };
};

const writes = (calls: Call[]): string[] =>
  calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);

test("a template pull request commits the file on a new branch, then opens the pull request, and answers its url", async () => {
  const { fetcher, calls } = github([{ path: "package-lock.json", type: "blob", sha: "p1" }]);
  const opened = await openTemplatePullRequest(fetcher, API, "token", TARGET, { template: TEMPLATE, replace: false });
  assert.deepEqual(opened, {
    kind: "Opened",
    pullRequest: {
      repository: "https://github.com/acme/app",
      branch: "tumpel/prebuild-template",
      pullRequestNumber: 12,
      url: "https://github.com/acme/app/pull/12",
      state: "Open",
    },
  });
  assert.deepEqual(writes(calls), [
    "POST /repos/acme/app/git/trees",
    "POST /repos/acme/app/git/commits",
    "POST /repos/acme/app/git/refs",
    "POST /repos/acme/app/pulls",
  ]);
  const [tree, commit, ref, pull] = calls.filter((call) => call.method !== "GET").map((call) => call.body);
  assert.deepEqual(tree, {
    base_tree: ROOT,
    tree: [{ path: ".devcontainer/devcontainer.json", mode: "100644", type: "blob", content: TEMPLATE.devcontainer }],
  });
  assert.deepEqual((commit as { parents: string[] }).parents, [HEAD]);
  assert.deepEqual(ref, { ref: "refs/heads/tumpel/prebuild-template", sha: COMMIT });
  assert.equal((pull as { base: string }).base, "trunk");
  assert.doesNotMatch((pull as { body: string }).body, /replaces/);
});

test("a repository holding either devcontainer path is refused naming the file, and nothing is written", async () => {
  const root = github([{ path: ".devcontainer.json", type: "blob", sha: "b0" }]);
  assert.deepEqual(
    await openTemplatePullRequest(root.fetcher, API, "token", TARGET, { template: TEMPLATE, replace: false }),
    { kind: "Exists", path: ".devcontainer.json" },
  );
  assert.deepEqual(writes(root.calls), []);
  const nested = github([{ path: ".devcontainer", type: "tree", sha: "d1" }]);
  assert.deepEqual(
    await openTemplatePullRequest(nested.fetcher, API, "token", TARGET, { template: TEMPLATE, replace: false }),
    { kind: "Exists", path: ".devcontainer/devcontainer.json" },
  );
  assert.deepEqual(writes(nested.calls), []);
});

test("with replace, the commit removes the root .devcontainer.json and the pull request says it replaces it", async () => {
  const { fetcher, calls } = github([{ path: ".devcontainer.json", type: "blob", sha: "b0" }]);
  const opened = await openTemplatePullRequest(fetcher, API, "token", TARGET, { template: TEMPLATE, replace: true });
  assert.equal(opened.kind, "Opened");
  const [tree, , , pull] = calls.filter((call) => call.method !== "GET").map((call) => call.body);
  assert.deepEqual((tree as { tree: unknown[] }).tree[1], {
    path: ".devcontainer.json",
    mode: "100644",
    type: "blob",
    sha: null,
  });
  assert.match((pull as { body: string }).body, /It replaces the existing \.devcontainer\.json\./);
});

test("an open template pull request is reused: the branch moves to the new commit and the pull request is updated", async () => {
  const { fetcher, calls } = github([], {
    "GET /repos/acme/app/git/ref/heads/tumpel/prebuild-template": { status: 200, body: { object: { sha: HEAD } } },
    "PATCH /repos/acme/app/git/refs/heads/tumpel/prebuild-template": { status: 200, body: { object: { sha: COMMIT } } },
    "GET /repos/acme/app/pulls?head=acme%3Atumpel%2Fprebuild-template&state=open&sort=created&direction=desc&per_page=1":
      { status: 200, body: [PULL] },
    "PATCH /repos/acme/app/pulls/12": { status: 200, body: PULL },
  });
  const opened = await openTemplatePullRequest(fetcher, API, "token", TARGET, { template: TEMPLATE, replace: false });
  assert.equal(opened.kind === "Opened" && opened.pullRequest.pullRequestNumber, 12);
  assert.deepEqual(writes(calls).slice(2), [
    "PATCH /repos/acme/app/git/refs/heads/tumpel/prebuild-template",
    "PATCH /repos/acme/app/pulls/12",
  ]);
  assert.deepEqual(calls.find((call) => call.method === "PATCH")?.body, { sha: COMMIT, force: true });
});

test("a pull request GitHub refuses answers GitHub's message", async () => {
  const { fetcher } = github([], {
    "POST /repos/acme/app/pulls": {
      status: 422,
      body: { message: "Validation Failed: a pull request already exists for acme:tumpel/prebuild-template" },
    },
  });
  assert.deepEqual(
    await openTemplatePullRequest(fetcher, API, "token", TARGET, { template: TEMPLATE, replace: false }),
    {
      kind: "Refused",
      detail:
        "GitHub answered POST https://api.github.test/repos/acme/app/pulls with 422: Validation Failed: a pull request already exists for acme:tumpel/prebuild-template",
    },
  );
});

const LIST_ALL =
  "GET /repos/acme/app/pulls?head=acme%3Atumpel%2Fprebuild-template&state=all&sort=created&direction=desc&per_page=1";

test("the template pull request reads Merged once merged, Closed when closed without a merge, and None when absent", async () => {
  const merged = github([], {
    [LIST_ALL]: { status: 200, body: [{ ...PULL, state: "closed", merged_at: "2026-11-17T10:00:00Z" }] },
  });
  const read = await readTemplatePullRequest(merged.fetcher, API, "token", TARGET);
  assert.equal(read.kind === "Read" && read.pullRequest.state, "Merged");
  const closed = github([], { [LIST_ALL]: { status: 200, body: [{ ...PULL, state: "closed" }] } });
  const readClosed = await readTemplatePullRequest(closed.fetcher, API, "token", TARGET);
  assert.equal(readClosed.kind === "Read" && readClosed.pullRequest.state, "Closed");
  const none = github([], { [LIST_ALL]: { status: 200, body: [] } });
  assert.deepEqual(await readTemplatePullRequest(none.fetcher, API, "token", TARGET), { kind: "None" });
});
