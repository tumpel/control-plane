import assert from "node:assert/strict";
import { test } from "node:test";
import { type Compactor, compactorOf } from "../src/compact.ts";

const compactorFor = (harness: "Codex" | "OpenCode" | "PiDev"): Compactor => {
  const compactor = compactorOf(harness);
  assert.ok(compactor);
  return compactor;
};

const kept = (compactor: Compactor, lines: unknown[]): string[] =>
  lines.map((line) => compactor(line)).filter((text): text is string => text !== null);

const piUsage = (input: number, cacheRead: number, output: number, total: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoning: 13,
  totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total, totalFromProvider: true },
});

const piToolCalls = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Let's take a look at package.json and the repository.\n" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "package.json", offset: 1, limit: 50 } },
    { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "ls && git status -s", timeout: 15 } },
  ],
  provider: "openrouter",
  model: "qwen/qwen3.8-27b",
  usage: piUsage(1521, 0, 120, 0.00042015),
  stopReason: "toolUse",
};

const piToolResult = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "read",
  content: [{ type: "text", text: '{\n  "name": "recall"\n}' }],
  isError: false,
};

const piDone = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "The draft PR has been created." },
    { type: "text", text: "\n\nDone. Draft PR opened: https://github.com/mvhenten/recall/pull/169" },
  ],
  usage: piUsage(88, 5440, 194, 0.0005956),
  stopReason: "stop",
};

const PI_TURN = [
  { type: "response", command: "prompt", success: true, data: { disposition: "started" } },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user", content: [{ type: "text", text: "Add a doctor script" }] } },
  { type: "message_end", message: { role: "user", content: [{ type: "text", text: "Add a doctor script" }] } },
  {
    type: "message_start",
    message: { ...piToolCalls, content: [], usage: piUsage(0, 0, 0, 0), stopReason: "pending" },
  },
  { type: "message_end", message: piToolCalls },
  { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "package.json" } },
  {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "read",
    result: { content: piToolResult.content },
    isError: false,
  },
  { type: "message_start", message: piToolResult },
  { type: "message_end", message: piToolResult },
  { type: "turn_end", message: piToolCalls, toolResults: [piToolResult] },
  { type: "turn_start" },
  { type: "message_end", message: piDone },
  { type: "turn_end", message: piDone, toolResults: [] },
  { type: "agent_end", messages: [piToolCalls, piToolResult, piDone], willRetry: false },
  { type: "agent_settled", aborted: false },
];

test("a Pi turn keeps each tool call once, the assistant text and one result line with tokens and cost", () => {
  assert.deepEqual(kept(compactorFor("PiDev"), PI_TURN), [
    "[read] package.json\n[bash] ls && git status -s",
    "Done. Draft PR opened: https://github.com/mvhenten/recall/pull/169",
    "[result] 1609 in, 5440 cache read, 314 out, $0.001016",
  ]);
});

test("a Pi message the provider ended with an error names the error after what it wrote", () => {
  const failed = {
    role: "assistant",
    content: [],
    usage: piUsage(0, 0, 0, 0),
    stopReason: "error",
    errorMessage: '429: {"message":"Rate limit exceeded: cohere/north-mini-code:free"}',
  };
  assert.deepEqual(kept(compactorFor("PiDev"), [{ type: "message_end", message: failed }]), [
    '[error] 429: {"message":"Rate limit exceeded: cohere/north-mini-code:free"}',
  ]);
});

const openCodeTokens = { input: 1521, output: 120, reasoning: 13, cache: { read: 2048, write: 0 } };

const OPENCODE_TURN = [
  {
    type: "step_start",
    timestamp: 1763215200000,
    sessionID: "ses_1",
    part: { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "step-start" },
  },
  {
    type: "text",
    timestamp: 1763215200100,
    sessionID: "ses_1",
    part: { id: "prt_2", type: "text", text: "Reading the package file.\n", time: { start: 1, end: 2 } },
  },
  {
    type: "tool_use",
    timestamp: 1763215200200,
    sessionID: "ses_1",
    part: {
      id: "prt_3",
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "npm test", description: "Runs the tests" },
        output: "a long test log",
        title: "npm test",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    },
  },
  {
    type: "step_finish",
    timestamp: 1763215200300,
    sessionID: "ses_1",
    part: { id: "prt_4", type: "step-finish", reason: "tool-calls", cost: 0.00042, tokens: openCodeTokens },
  },
  {
    type: "error",
    timestamp: 1763215200400,
    sessionID: "ses_1",
    error: { name: "APIError", data: { message: "qwen/qwen3-coderx is not a valid model ID", statusCode: 400 } },
  },
  {
    type: "error",
    timestamp: 1763215200500,
    sessionID: "ses_1",
    error: { name: "UnknownError", data: {} },
  },
];

test("an OpenCode turn keeps the text, one line per tool call, each step's tokens and cost and each error", () => {
  assert.deepEqual(kept(compactorFor("OpenCode"), OPENCODE_TURN), [
    "Reading the package file.",
    "[bash] npm test",
    "[step] 1521 in, 2048 cache read, 120 out, $0.000420",
    "[error] qwen/qwen3-coderx is not a valid model ID",
    "[error] UnknownError",
  ]);
});

const CODEX_TURN = [
  { type: "thread.started", thread_id: "01a1e3dc-9221-7c81-a845-f702e3f8b4ea" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Looking at the repo**" } },
  {
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" },
  },
  {
    type: "item.completed",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "ls",
      aggregated_output: "README.md\npackage.json\n",
      exit_code: 0,
      status: "completed",
    },
  },
  { type: "item.updated", item: { id: "item_2", type: "todo_list", items: [] } },
  {
    type: "item.started",
    item: {
      id: "item_3",
      type: "mcp_tool_call",
      server: "tumpel",
      tool: "whoami",
      arguments: {},
      status: "in_progress",
    },
  },
  {
    type: "item.completed",
    item: { id: "item_3", type: "mcp_tool_call", server: "tumpel", tool: "whoami", arguments: {}, status: "completed" },
  },
  {
    type: "item.completed",
    item: {
      id: "item_4",
      type: "file_change",
      changes: [
        { path: "package.json", kind: "update" },
        { path: "npm-scripts/doctor.mjs", kind: "add" },
      ],
      status: "completed",
    },
  },
  {
    type: "item.completed",
    item: { id: "item_5", type: "error", message: "Model metadata for `qwen/qwen3-coder` not found." },
  },
  { type: "item.completed", item: { id: "item_6", type: "agent_message", text: "Added the doctor script." } },
  { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } },
  { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } },
  { type: "error", message: "stream disconnected before completion" },
];

test("a Codex turn keeps each tool call once when it starts, the agent's text, the token line and errors", () => {
  assert.deepEqual(kept(compactorFor("Codex"), CODEX_TURN), [
    "[command] ls",
    "[tumpel.whoami]",
    "[file_change] update package.json, add npm-scripts/doctor.mjs",
    "Added the doctor script.",
    "[result] 10 in, 4 cache read, 3 out",
    "[error] unexpected status 401 Unauthorized",
    "[error] stream disconnected before completion",
  ]);
});
