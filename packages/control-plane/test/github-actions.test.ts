import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fetch } from "../src/github.ts";
import { callerWorkflowExample, dispatchCallerWorkflow, syncCallerWorkflow } from "../src/github-actions.ts";

type Call = { url: string; init: RequestInit };

const answering = (response: () => Response): { fetcher: Fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const fetcher: Fetch = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { fetcher, calls };
};

const DISPATCH = { callerWorkflow: ".github/workflows/tumpel-prebuild.yml", ref: "trunk" };
const TARGET = { owner: "acme", name: "app" };

test("the dispatch posts the caller workflow's file on the default branch with no inputs", async () => {
  const { fetcher, calls } = answering(() => new Response(null, { status: 204 }));
  const answer = await dispatchCallerWorkflow(
    fetcher,
    "https://api.github.test",
    "installation-token",
    TARGET,
    DISPATCH,
  );
  assert.deepEqual(answer, { kind: "Dispatched" });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  assert.equal(call.url, "https://api.github.test/repos/acme/app/actions/workflows/tumpel-prebuild.yml/dispatches");
  assert.equal(call.init.method, "POST");
  assert.equal(new Headers(call.init.headers).get("authorization"), "Bearer installation-token");
  assert.deepEqual(JSON.parse(String(call.init.body)), { ref: "trunk" });
});

test("a dispatch refused because Actions are disabled is told apart from any other refusal", async () => {
  const refused = (status: number, message: string) =>
    dispatchCallerWorkflow(
      answering(() => Response.json({ message }, { status })).fetcher,
      "https://api.github.test",
      "t",
      TARGET,
      DISPATCH,
    );
  const disabled = await refused(422, "Cannot trigger a 'workflow_dispatch' on a disabled workflow");
  assert.equal(disabled.kind, "ActionsDisabled");
  const other = await refused(422, "Workflow does not have 'workflow_dispatch' trigger");
  assert.equal(other.kind, "Refused");
  assert.match(other.kind === "Refused" ? other.detail : "", /422: Workflow does not have 'workflow_dispatch' trigger/);
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
const CALLER = { path: ".github/workflows/tumpel-prebuild.yml", apiOrigin: "https://api.tumpel.test" };
const EXAMPLE = callerWorkflowExample(CALLER);
const ALL_WRITE = { actions: "write", contents: "write", workflows: "write" };
const COMMITTED: [number, unknown] = [201, { commit: { sha: "c".repeat(40) } }];
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
  syncCallerWorkflow(fetcher, "https://api.github.test", { token: "t", permissions }, TARGET, {
    ...CALLER,
    branch: "trunk",
  });

test("a missing caller workflow is committed to the default branch as the current example, which starts its own run on push", async () => {
  const { fetcher, calls } = routed({ [`PUT ${CONTENTS}`]: COMMITTED });
  assert.deepEqual(await sync(fetcher, ALL_WRITE), { kind: "Committed", commitSha: "c".repeat(40) });
  assert.equal(calls[0]?.url, `${CONTENTS}?ref=trunk`);
  const body = JSON.parse(String(calls[1]?.init.body));
  const committed = Buffer.from(body.content, "base64").toString();
  assert.equal(committed, EXAMPLE);
  assert.match(committed, /push:\n {4}paths:\n {6}- \.github\/workflows\/tumpel-prebuild\.yml\n/);
  assert.match(committed, /apiOrigin: https:\/\/api\.tumpel\.test\n/);
  assert.doesNotMatch(committed, /inputs:/);
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
  const { fetcher, calls } = routed({ [`GET ${CONTENTS}?ref=trunk`]: file(EXAMPLE) });
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
