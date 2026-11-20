import assert from "node:assert/strict";
import { test } from "node:test";
import { conditionRows, conditionsOf, fillPrompt, matches, verdicts } from "../src/trigger-match.ts";

const merged = {
  action: "closed",
  number: 88,
  pull_request: {
    merged: true,
    draft: false,
    html_url: "https://github.com/acme/billing/pull/88",
    merged_by: { login: "jdoe" },
    labels: [{ name: "bug" }, { name: "agent:review" }],
    milestone: null,
  },
  repository: { full_name: "acme/billing" },
};

test("a condition compares scalars by their JSON text and crosses arrays", () => {
  assert.deepEqual(
    verdicts(
      [
        { field: "action", values: ["closed"] },
        { field: "pull_request.merged", values: ["true"] },
        { field: "number", values: ["87", "88"] },
        { field: "pull_request.labels.name", values: ["agent:review"] },
        { field: "pull_request.draft", values: ["true"] },
      ],
      merged,
    ).map((verdict) => [verdict.field, verdict.actual, verdict.holds]),
    [
      ["action", ["closed"], true],
      ["pull_request.merged", ["true"], true],
      ["number", ["88"], true],
      ["pull_request.labels.name", ["bug", "agent:review"], true],
      ["pull_request.draft", ["false"], false],
    ],
  );
});

test("a path that is absent, null or ends on an object holds for no value", () => {
  assert.deepEqual(
    verdicts(
      [
        { field: "pull_request.milestone", values: ["null"] },
        { field: "pull_request.merged_by", values: ["jdoe"] },
        { field: "pusher.name", values: ["jdoe"] },
      ],
      merged,
    ).map((verdict) => [verdict.actual, verdict.holds]),
    [
      [[], false],
      [[], false],
      [[], false],
    ],
  );
});

test("a trigger matches only when every condition holds, and with no condition always", () => {
  assert.equal(matches([], merged), true);
  assert.equal(
    matches(
      [
        { field: "repository.full_name", values: ["acme/billing"] },
        { field: "pull_request.merged_by.login", values: ["jdoe"] },
      ],
      merged,
    ),
    true,
  );
  assert.equal(
    matches(
      [
        { field: "repository.full_name", values: ["acme/billing"] },
        { field: "pull_request.merged_by.login", values: ["someone"] },
      ],
      merged,
    ),
    false,
  );
});

test("a prompt fills each placeholder, an array as a list, and keeps and names each field the payload lacks", () => {
  assert.deepEqual(
    fillPrompt(
      "{{pull_request.merged_by.login}} merged {{ pull_request.html_url }} with {{pull_request.labels.name}}",
      merged,
    ),
    { prompt: "jdoe merged https://github.com/acme/billing/pull/88 with bug, agent:review", missingFields: [] },
  );
  assert.deepEqual(fillPrompt("Work on {{issue.html_url}} at {{sha}} for {{issue.html_url}}", merged), {
    prompt: "Work on {{issue.html_url}} at {{sha}} for {{issue.html_url}}",
    missingFields: ["issue.html_url", "sha"],
  });
});

test("conditions survive the row round trip in order, two on one field stay two", () => {
  const conditions = [
    { field: "label.name", values: ["agent:work"] },
    { field: "action", values: ["opened", "reopened"] },
    { field: "label.name", values: ["urgent"] },
  ];
  assert.deepEqual(conditionsOf(conditionRows(conditions)), conditions);
});
