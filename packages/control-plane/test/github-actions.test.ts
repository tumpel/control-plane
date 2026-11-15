import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Fetch } from "../src/github.ts";
import { DISPATCH_INPUTS, dispatchCallerWorkflow } from "../src/github-actions.ts";

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

test("the dispatch inputs are the workflow_call inputs of the reusable workflow", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/prebuild.yml", import.meta.url), "utf8");
  const declared = workflow.match(/^on:\n {2}workflow_call:\n {4}inputs:\n((?: {6}.*\n)+)/m);
  assert.ok(declared, ".github/workflows/prebuild.yml declares on.workflow_call.inputs");
  const expected = DISPATCH_INPUTS.map(
    ([name, description]) =>
      `      ${name}:\n        description: ${description}\n        required: true\n        type: string\n`,
  ).join("");
  assert.equal(declared[1], expected);
});
