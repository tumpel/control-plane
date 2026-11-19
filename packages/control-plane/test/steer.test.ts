import assert from "node:assert/strict";
import { test } from "node:test";
import { STEER_CONNECTOR_ID, withSteerHooks } from "../src/steer.ts";

const hook = {
  hooks: [
    {
      type: "command",
      command: `curl -sSf -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:47160/connectors/${STEER_CONNECTOR_ID}`,
    },
  ],
};

test("the steer hooks join a persona's own hooks and settings after them", () => {
  const own = { hooks: [{ type: "command", command: "./lint.sh" }] };
  const merged = withSteerHooks(JSON.stringify({ model: "opus", hooks: { PostToolUse: [own], SessionStart: [own] } }));
  assert.deepEqual(JSON.parse(merged ?? ""), {
    model: "opus",
    hooks: { PostToolUse: [own, hook], SessionStart: [own], Stop: [hook] },
  });
});

test("a persona without settings gets only the steer hooks", () => {
  assert.deepEqual(JSON.parse(withSteerHooks(null) ?? ""), { hooks: { PostToolUse: [hook], Stop: [hook] } });
});

test("settings that are not a JSON object, or hooks that are not lists, take no steer hooks", () => {
  for (const settings of ["not json", "[]", '{"hooks":{"Stop":{}}}']) assert.equal(withSteerHooks(settings), null);
});
