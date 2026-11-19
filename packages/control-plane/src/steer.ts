import { z } from "zod";

export const STEER_CONNECTOR_ID = "281a4fb5-d540-527a-917e-5aa2fce314a6";
export const STEER_CONNECTOR_NAME = "tumpel-steer";
export const STEER_SETTINGS_PATH = ".claude/settings.json";
const FORWARDER_PORT = 47160;

const HOOK_COMMAND = `curl -sSf -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:${FORWARDER_PORT}/connectors/${STEER_CONNECTOR_ID}`;
const HOOK_GROUP = { hooks: [{ type: "command", command: HOOK_COMMAND }] };
const STEER_EVENTS = ["PostToolUse", "Stop"] as const;

const SettingsSchema = z.looseObject({
  hooks: z.record(z.string(), z.array(z.unknown())).optional(),
});

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const withSteerHooks = (settings: string | null): string | null => {
  const parsed = SettingsSchema.safeParse(settings === null ? {} : parseJson(settings));
  if (!parsed.success) return null;
  const hooks = { ...parsed.data.hooks };
  for (const event of STEER_EVENTS) hooks[event] = [...(hooks[event] ?? []), HOOK_GROUP];
  return JSON.stringify({ ...parsed.data, hooks });
};

const HookInputSchema = z.object({ hook_event_name: z.enum(STEER_EVENTS) });

const McpMessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  id: z.union([z.string(), z.number()]).optional(),
  params: z.object({ protocolVersion: z.string() }).partial().optional(),
});

export const SteerInboxRequestSchema = z.union([HookInputSchema, McpMessageSchema]);
export type SteerInboxRequest = z.infer<typeof SteerInboxRequestSchema>;
type HookInput = z.infer<typeof HookInputSchema>;
type McpMessage = z.infer<typeof McpMessageSchema>;

export const isHookInput = (request: SteerInboxRequest): request is HookInput => "hook_event_name" in request;

const steerText = (prompts: readonly string[]): string =>
  `The user sent this while you worked. Act on it now, inside this turn:\n\n${prompts.join("\n\n")}`;

export const hookAnswer = (input: HookInput, prompts: readonly string[]): Record<string, unknown> => {
  if (prompts.length === 0) return {};
  if (input.hook_event_name === "Stop") return { decision: "block", reason: steerText(prompts) };
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: steerText(prompts) } };
};

export const mcpAnswer = (message: McpMessage): Record<string, unknown> | null => {
  if (message.id === undefined) return null;
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: {},
        serverInfo: { name: STEER_CONNECTOR_NAME, version: "1" },
      },
    };
  }
  if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `${STEER_CONNECTOR_NAME} serves no ${message.method}` },
  };
};
