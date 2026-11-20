import assert from "node:assert/strict";
import { test } from "node:test";
import { steerHookOutput, steerSettings } from "../src/steer.ts";

test("the steer hooks join the persona's own hooks and keep every other setting", () => {
  const own = { matcher: "Bash", hooks: [{ type: "command", command: "lint" }] };
  const merged = JSON.parse(steerSettings(JSON.stringify({ model: "opus", hooks: { PostToolUse: [own] } })) ?? "");
  assert.equal(merged.model, "opus");
  assert.equal(merged.hooks.PostToolUse.length, 2);
  assert.deepEqual(merged.hooks.PostToolUse[0], own);
  assert.match(
    merged.hooks.PostToolUse[1].hooks[0].command,
    /x-tumpel-steer: PostToolUse.*127\.0\.0\.1:47160\/connectors\/steer$/,
  );
  assert.match(merged.hooks.Stop[0].hooks[0].command, /x-tumpel-steer: Stop/);
});

test("a persona with no settings file gets one that holds the steer hooks alone", () => {
  assert.deepEqual(Object.keys(JSON.parse(steerSettings(null) ?? "")), ["hooks"]);
});

test("settings that are not a JSON object, or hooks of another shape, take no steer", () => {
  for (const raw of ["[]", "not json", '{"hooks": []}', '{"hooks": {"Stop": {}}}']) {
    assert.equal(steerSettings(raw), null, raw);
  }
});

test("a steer reaches Claude Code as added context after a tool call and as a block at the end of the turn", () => {
  assert.deepEqual(steerHookOutput("Stop", []), {});
  assert.deepEqual(steerHookOutput("PostToolUse", []), {});
  assert.equal(steerHookOutput("Stop", ["use pnpm"]).decision, "block");
  assert.match(String(steerHookOutput("Stop", ["use pnpm"]).reason), /use pnpm/);
  assert.deepEqual(steerHookOutput("PostToolUse", ["a", "b"]).hookSpecificOutput, {
    hookEventName: "PostToolUse",
    additionalContext: "The person steering this turn says:\n\na\n\nb",
  });
});
