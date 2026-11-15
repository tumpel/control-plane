import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Fetch } from "../src/github.ts";
import { type InputFile, inputDigest, readInputs } from "../src/prebuild-inputs.ts";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const FIXTURE: InputFile[] = [
  { path: "package-lock.json", blobSha: "a1" },
  { path: ".devcontainer/devcontainer.json", blobSha: "b2" },
  { path: ".devcontainer/Dockerfile", blobSha: "c3" },
  { path: "Cargo.lock", blobSha: "d4" },
];

const TARGET = { owner: "acme", name: "app" };
const HEAD = "1".repeat(40);
const ROOT = "2".repeat(40);

test("the input digest hashes each file's path and git blob sha in byte order of the path, whatever order they arrive in", async () => {
  const lines = [
    ".devcontainer/Dockerfile\0c3\n",
    ".devcontainer/devcontainer.json\0b2\n",
    "Cargo.lock\0d4\n",
    "package-lock.json\0a1\n",
  ].join("");
  assert.equal(await inputDigest(FIXTURE), sha(lines));
  assert.equal(await inputDigest([...FIXTURE].reverse()), sha(lines));
  const changed = FIXTURE.map((entry) => (entry.path === "Cargo.lock" ? { ...entry, blobSha: "e5" } : entry));
  assert.notEqual(await inputDigest(changed), sha(lines));
  const moved = FIXTURE.map((entry) => (entry.path === "Cargo.lock" ? { ...entry, path: "go.sum" } : entry));
  assert.notEqual(await inputDigest(moved), sha(lines));
});

type Entry = { path: string; type: string; sha: string };
type Call = { url: string; init: RequestInit };

const github = (trees: Record<string, Entry[]>) => {
  const calls: Call[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/repos/acme/app")) return Response.json({ default_branch: "trunk" });
    if (url.endsWith("/repos/acme/app/branches/trunk")) {
      return Response.json({ name: "trunk", commit: { sha: HEAD, commit: { tree: { sha: ROOT } } } });
    }
    const tree = /\/git\/trees\/([^?]+)/.exec(url)?.[1] ?? "";
    const entries = trees[tree];
    if (entries === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ truncated: false, tree: entries });
  };
  return { fetcher, calls };
};

test("the inputs are the root lockfiles and every blob under .devcontainer of the default branch's head commit, read from two trees and no blobs", async () => {
  const { fetcher, calls } = github({
    [ROOT]: [
      { path: ".devcontainer", type: "tree", sha: "t1" },
      { path: ".devcontainer.json", type: "blob", sha: "b0" },
      { path: "Cargo.lock", type: "blob", sha: "b2" },
      { path: "README.md", type: "blob", sha: "b3" },
      { path: "web", type: "tree", sha: "t2" },
      { path: ".devcontainerx", type: "tree", sha: "t3" },
    ],
    t1: [
      { path: "Dockerfile", type: "blob", sha: "b1" },
      { path: "scripts", type: "tree", sha: "t4" },
      { path: "scripts/setup.sh", type: "blob", sha: "b5" },
    ],
  });
  const inputs = await readInputs(fetcher, "https://api.github.com", TARGET, "installation-token");
  assert.deepEqual(inputs, {
    kind: "Read",
    files: [
      { path: ".devcontainer.json", blobSha: "b0" },
      { path: "Cargo.lock", blobSha: "b2" },
      { path: ".devcontainer/Dockerfile", blobSha: "b1" },
      { path: ".devcontainer/scripts/setup.sh", blobSha: "b5" },
    ],
    configSource: "RepositoryFile",
    defaultBranch: "trunk",
    headSha: HEAD,
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://api.github.com/repos/acme/app",
      "https://api.github.com/repos/acme/app/branches/trunk",
      `https://api.github.com/repos/acme/app/git/trees/${ROOT}`,
      "https://api.github.com/repos/acme/app/git/trees/t1?recursive=1",
    ],
  );
  assert.deepEqual(
    calls.map((call) => new Headers(call.init.headers).get("authorization")),
    calls.map(() => "Bearer installation-token"),
  );
});

test("a repository without a devcontainer.json builds with the default config, read from the manifests it detects", async () => {
  const bare = await readInputs(
    github({ [ROOT]: [{ path: "README.md", type: "blob", sha: "b3" }] }).fetcher,
    "https://api.github.com",
    TARGET,
    "t",
  );
  assert.deepEqual(bare, { kind: "Read", files: [], configSource: "Default", defaultBranch: "trunk", headSha: HEAD });
  const python = await readInputs(
    github({
      [ROOT]: [
        { path: ".devcontainer", type: "tree", sha: "t1" },
        { path: "requirements.txt", type: "blob", sha: "b4" },
      ],
      t1: [{ path: "Dockerfile", type: "blob", sha: "b1" }],
    }).fetcher,
    "https://api.github.com",
    TARGET,
    "t",
  );
  assert.equal(python.kind === "Read" ? python.configSource : python.kind, "Default");
  assert.deepEqual(python.kind === "Read" ? python.files.map((file) => file.path) : [], [
    "requirements.txt",
    ".devcontainer/Dockerfile",
  ]);
});

test("a tree GitHub refuses reads Unreadable", async () => {
  const missing = await readInputs(
    github({ [ROOT]: [{ path: ".devcontainer", type: "tree", sha: "gone" }] }).fetcher,
    "https://api.github.com",
    TARGET,
    "t",
  );
  assert.equal(missing.kind, "Unreadable");
  assert.match(missing.kind === "Unreadable" ? missing.detail : "", /acme\/app/);
});
