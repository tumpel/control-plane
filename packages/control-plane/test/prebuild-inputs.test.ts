import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Fetch } from "../src/github.ts";
import { countsAsInput, type InputFile, inputDigest, readInputs } from "../src/prebuild-inputs.ts";

const file = (path: string, text: string): InputFile => ({ path, bytes: new TextEncoder().encode(text) });
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const FIXTURE = [
  file("package-lock.json", '{"lockfileVersion":3}\n'),
  file(".devcontainer/devcontainer.json", '{"image":"ubuntu"}\n'),
  file(".devcontainer/Dockerfile", "FROM ubuntu\n"),
  file("Cargo.lock", "version = 4\n"),
];

test("the input digest hashes each file's path and sha256 in byte order of the path, whatever order they arrive in", async () => {
  const lines = [
    `.devcontainer/Dockerfile\0${sha("FROM ubuntu\n")}\n`,
    `.devcontainer/devcontainer.json\0${sha('{"image":"ubuntu"}\n')}\n`,
    `Cargo.lock\0${sha("version = 4\n")}\n`,
    `package-lock.json\0${sha('{"lockfileVersion":3}\n')}\n`,
  ].join("");
  assert.equal(await inputDigest(FIXTURE), sha(lines));
  assert.equal(await inputDigest([...FIXTURE].reverse()), sha(lines));
  const changed = FIXTURE.map((entry) => (entry.path === "Cargo.lock" ? file("Cargo.lock", "version = 3\n") : entry));
  assert.notEqual(await inputDigest(changed), sha(lines));
  const moved = FIXTURE.map((entry) => (entry.path === "Cargo.lock" ? { ...entry, path: "go.sum" } : entry));
  assert.notEqual(await inputDigest(moved), sha(lines));
});

test("only devcontainer files and root lockfiles count as inputs", () => {
  for (const path of [".devcontainer/devcontainer.json", ".devcontainer/a/b.sh", ".devcontainer.json", "yarn.lock"]) {
    assert.ok(countsAsInput(path), path);
  }
  for (const path of ["packages/app/package-lock.json", "README.md", ".devcontainerx/a", "src/Cargo.lock"]) {
    assert.ok(!countsAsInput(path), path);
  }
});

type Call = { url: string; init: RequestInit };

const github = (
  tree: { path: string; type: string; sha: string }[],
  blobs: Record<string, string>,
  truncated = false,
) => {
  const calls: Call[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/repos/acme/app")) return Response.json({ default_branch: "trunk" });
    if (url.includes("/git/trees/")) return Response.json({ truncated, tree });
    const blob = /\/git\/blobs\/(\w+)$/.exec(url)?.[1] ?? "";
    const text = blobs[blob];
    if (text === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
    return Response.json({ encoding: "base64", content: Buffer.from(text).toString("base64") });
  };
  return { fetcher, calls };
};

test("the inputs are read from the default branch's tree with the token, fetching only the counted blobs", async () => {
  const { fetcher, calls } = github(
    [
      { path: ".devcontainer", type: "tree", sha: "t1" },
      { path: ".devcontainer/Dockerfile", type: "blob", sha: "b1" },
      { path: "Cargo.lock", type: "blob", sha: "b2" },
      { path: "README.md", type: "blob", sha: "b3" },
      { path: "web/package-lock.json", type: "blob", sha: "b4" },
    ],
    { b1: "FROM ubuntu\n", b2: "version = 4\n" },
  );
  const inputs = await readInputs(fetcher, "https://github.com/acme/app.git", "installation-token");
  assert.equal(inputs.kind, "Read");
  assert.deepEqual(
    inputs.kind === "Read" ? inputs.files.map((entry) => [entry.path, new TextDecoder().decode(entry.bytes)]) : [],
    [
      [".devcontainer/Dockerfile", "FROM ubuntu\n"],
      ["Cargo.lock", "version = 4\n"],
    ],
  );
  assert.equal(calls[1]?.url, "https://api.github.com/repos/acme/app/git/trees/trunk?recursive=1");
  assert.deepEqual(
    calls.map((call) => new Headers(call.init.headers).get("authorization")),
    calls.map(() => "Bearer installation-token"),
  );
});

test("a repository without inputs reads Empty, a truncated tree or a missing blob reads Unreadable", async () => {
  const empty = await readInputs(
    github([{ path: "README.md", type: "blob", sha: "b3" }], {}).fetcher,
    "https://github.com/acme/app",
    null,
  );
  assert.equal(empty.kind, "Empty");
  assert.match(empty.kind === "Empty" ? empty.detail : "", /no \.devcontainer\/ directory/);

  const truncated = await readInputs(github([], {}, true).fetcher, "https://github.com/acme/app", null);
  assert.equal(truncated.kind, "Unreadable");

  const missing = await readInputs(
    github([{ path: "go.sum", type: "blob", sha: "gone" }], {}).fetcher,
    "https://github.com/acme/app",
    null,
  );
  assert.equal(missing.kind, "Unreadable");
  assert.match(missing.kind === "Unreadable" ? missing.detail : "", /tumpel github start/);
});
