import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fetch } from "../src/github.ts";
import { CALLER_WORKFLOW_EXAMPLE, dispatchCallerWorkflow, syncCallerWorkflow } from "../src/github-actions.ts";

type Call = { url: string; init: RequestInit };

const spied = (status: number, body: unknown): { fetcher: Fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json(body, { status });
  };
  return { fetcher, calls };
};

const INPUTS = {
  prebuildId: "p-1",
  tenantId: "t-1",
  apiOrigin: "https://api.tumpel.test",
  rootfsUrl: "https://r2.example.test/images/rootfs/abc?X-Amz-Signature=x",
  imageDigest: "f".repeat(64),
};

const DISPATCH = { callerWorkflow: ".github/workflows/tumpel-prebuild.yml", ref: "trunk", inputs: INPUTS };

test("the dispatch posts the caller workflow's file on the default branch with the five inputs and asks for the run", async () => {
  const { fetcher, calls } = spied(200, {
    workflow_run_id: 4242,
    run_url: "https://api.github.com/repos/acme/app/actions/runs/4242",
    html_url: "https://github.com/acme/app/actions/runs/4242",
  });
  const answer = await dispatchCallerWorkflow(
    fetcher,
    "https://api.github.test",
    "installation-token",
    { owner: "acme", name: "app" },
    DISPATCH,
  );
  assert.deepEqual(answer, {
    ok: true,
    value: { runId: 4242, htmlUrl: "https://github.com/acme/app/actions/runs/4242" },
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  assert.equal(call.url, "https://api.github.test/repos/acme/app/actions/workflows/tumpel-prebuild.yml/dispatches");
  assert.equal(call.init.method, "POST");
  assert.equal(new Headers(call.init.headers).get("authorization"), "Bearer installation-token");
  assert.deepEqual(JSON.parse(String(call.init.body)), { ref: "trunk", inputs: INPUTS, return_run_details: true });
});

test("a dispatch GitHub refuses answers its status and message", async () => {
  const refused = await dispatchCallerWorkflow(
    spied(422, { message: "Workflow does not have 'workflow_dispatch' trigger" }).fetcher,
    "https://api.github.test",
    "t",
    { owner: "acme", name: "app" },
    DISPATCH,
  );
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.detail, /422: Workflow does not have 'workflow_dispatch' trigger/);
});

const routed = (routes: Record<string, [number, unknown]>): { fetcher: Fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init });
    const [status, body] = routes[`${init.method} ${url}`] ?? [404, { message: "Not Found" }];
    return Response.json(body, { status });
  };
  return { fetcher, calls };
};

const CONTENTS = "https://api.github.test/repos/acme/app/contents/.github/workflows/tumpel-prebuild.yml";
const LOCATION = { path: ".github/workflows/tumpel-prebuild.yml", branch: "trunk" };
const ALL_WRITE = { actions: "write", contents: "write", workflows: "write" };
const COMMITTED: [number, unknown] = [201, { commit: { sha: "c".repeat(40), parents: [{ sha: "a".repeat(40) }] } }];
const file = (text: string): [number, unknown] => [
  200,
  {
    sha: "b".repeat(40),
    encoding: "base64",
    content: Buffer.from(text)
      .toString("base64")
      .replace(/(.{60})/g, "$1\n"),
  },
];
const sync = (fetcher: Fetch, permissions: Record<string, string>) =>
  syncCallerWorkflow(
    fetcher,
    "https://api.github.test",
    { token: "t", permissions },
    { owner: "acme", name: "app" },
    LOCATION,
  );

test("a missing caller workflow is committed to the default branch as the current example", async () => {
  const { fetcher, calls } = routed({ [`PUT ${CONTENTS}`]: COMMITTED });
  assert.deepEqual(await sync(fetcher, ALL_WRITE), {
    kind: "Committed",
    commitSha: "c".repeat(40),
    parentShas: ["a".repeat(40)],
  });
  assert.equal(calls[0]?.url, `${CONTENTS}?ref=trunk`);
  const body = JSON.parse(String(calls[1]?.init.body));
  assert.equal(Buffer.from(body.content, "base64").toString(), CALLER_WORKFLOW_EXAMPLE);
  assert.equal(body.branch, "trunk");
  assert.equal(body.sha, undefined);
});

test("a caller workflow that differs from the example is replaced at its blob", async () => {
  const { fetcher, calls } = routed({
    [`GET ${CONTENTS}?ref=trunk`]: file("name: old\n"),
    [`PUT ${CONTENTS}`]: COMMITTED,
  });
  assert.equal((await sync(fetcher, ALL_WRITE)).kind, "Committed");
  assert.equal(JSON.parse(String(calls[1]?.init.body)).sha, "b".repeat(40));
});

test("a current caller workflow is left alone and needs only Actions write", async () => {
  const { fetcher, calls } = routed({ [`GET ${CONTENTS}?ref=trunk`]: file(CALLER_WORKFLOW_EXAMPLE) });
  assert.deepEqual(await sync(fetcher, { actions: "write", contents: "read" }), { kind: "Current" });
  assert.equal(calls.length, 1);
});

test("an installation without the write permissions a commit needs names each one and commits nothing", async () => {
  const { fetcher, calls } = routed({});
  assert.deepEqual(await sync(fetcher, { actions: "read", contents: "write" }), {
    kind: "PermissionMissing",
    permissions: ["Actions", "Workflows"],
  });
  assert.equal(calls.length, 1);
});
