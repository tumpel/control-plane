import type { HarnessSchema } from "@tumpel/api/schemas";
import { z } from "zod";

export type Compactor = (line: unknown) => string | null;

type Harness = z.infer<typeof HarnessSchema>;

const TOOL_ARGUMENT_CHARS = 400;

const oneLine = (value: string): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > TOOL_ARGUMENT_CHARS ? `${flat.slice(0, TOOL_ARGUMENT_CHARS)}…` : flat;
};

const toolCall = (name: string, input: Record<string, unknown>): string => {
  const [first] = Object.values(input);
  if (first === undefined) return `[${name}]`;
  return `[${name}] ${oneLine(typeof first === "string" ? first : JSON.stringify(first))}`;
};

interface Tokens {
  input: number;
  cacheRead: number;
  output: number;
}

const tokens = ({ input, cacheRead, output }: Tokens): string => `${input} in, ${cacheRead} cache read, ${output} out`;

const dollars = (cost: number): string => `$${cost.toFixed(6)}`;

const joined = (parts: string[]): string | null => (parts.length === 0 ? null : parts.join("\n"));

const ClaudeCodeAssistantSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("tool_use"), name: z.string(), input: z.record(z.string(), z.unknown()) }),
        z.object({ type: z.string() }),
      ]),
    ),
  }),
});

const compactClaudeCode = (line: unknown): string | null => {
  const assistant = ClaudeCodeAssistantSchema.safeParse(line);
  if (!assistant.success) return null;
  return joined(
    assistant.data.message.content.flatMap((block): string[] => {
      if ("text" in block && block.text !== "") return [block.text];
      if ("name" in block) return [toolCall(block.name, block.input)];
      return [];
    }),
  );
};

const PiUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cost: z.object({ total: z.number() }),
});

const PiAssistantSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("toolCall"), name: z.string(), arguments: z.record(z.string(), z.unknown()) }),
      z.object({ type: z.string() }),
    ]),
  ),
  usage: PiUsageSchema,
});

const PiLineSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message_end"),
    message: z.union([
      PiAssistantSchema.extend({ errorMessage: z.string() }),
      PiAssistantSchema,
      z.object({ role: z.string() }),
    ]),
  }),
  z.object({
    type: z.literal("agent_end"),
    messages: z.array(z.union([PiAssistantSchema, z.object({ role: z.string() })])),
  }),
]);

const compactPi = (line: unknown): string | null => {
  const parsed = PiLineSchema.safeParse(line);
  if (!parsed.success) return null;
  if (parsed.data.type === "agent_end") {
    const usages = parsed.data.messages.flatMap((message) => ("usage" in message ? [message.usage] : []));
    const sum = (pick: (usage: z.infer<typeof PiUsageSchema>) => number): number =>
      usages.reduce((total, usage) => total + pick(usage), 0);
    const total = { input: sum((u) => u.input), cacheRead: sum((u) => u.cacheRead), output: sum((u) => u.output) };
    return `[result] ${tokens(total)}, ${dollars(sum((u) => u.cost.total))}`;
  }
  const { message } = parsed.data;
  if (!("content" in message)) return null;
  const parts = message.content.flatMap((block): string[] => {
    if ("text" in block && block.text.trim() !== "") return [block.text.trim()];
    if ("arguments" in block) return [toolCall(block.name, block.arguments)];
    return [];
  });
  return joined("errorMessage" in message ? [...parts, `[error] ${oneLine(message.errorMessage)}`] : parts);
};

const OpenCodeLineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), part: z.object({ text: z.string() }) }),
  z.object({
    type: z.literal("tool_use"),
    part: z.object({ tool: z.string(), state: z.object({ input: z.record(z.string(), z.unknown()) }) }),
  }),
  z.object({
    type: z.literal("step_finish"),
    part: z.object({
      cost: z.number(),
      tokens: z.object({ input: z.number(), output: z.number(), cache: z.object({ read: z.number() }) }),
    }),
  }),
  z.object({
    type: z.literal("error"),
    error: z.union([z.object({ data: z.object({ message: z.string() }) }), z.object({ name: z.string() })]),
  }),
]);

const compactOpenCode = (line: unknown): string | null => {
  const parsed = OpenCodeLineSchema.safeParse(line);
  if (!parsed.success) return null;
  const event = parsed.data;
  switch (event.type) {
    case "text":
      return event.part.text.trim() === "" ? null : event.part.text.trim();
    case "tool_use":
      return toolCall(event.part.tool, event.part.state.input);
    case "step_finish": {
      const { input, output, cache } = event.part.tokens;
      return `[step] ${tokens({ input, cacheRead: cache.read, output })}, ${dollars(event.part.cost)}`;
    }
    case "error":
      return `[error] ${oneLine("data" in event.error ? event.error.data.message : event.error.name)}`;
  }
};

const CodexStartedItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command_execution"), command: z.string() }),
  z.object({
    type: z.literal("mcp_tool_call"),
    server: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }),
]);

const CodexCompletedItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_message"), text: z.string() }),
  z.object({ type: z.literal("file_change"), changes: z.array(z.object({ path: z.string(), kind: z.string() })) }),
  z.object({ type: z.literal("web_search"), query: z.string() }),
]);

const CodexLineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item.started"), item: CodexStartedItemSchema }),
  z.object({ type: z.literal("item.completed"), item: CodexCompletedItemSchema }),
  z.object({
    type: z.literal("turn.completed"),
    usage: z.object({ input_tokens: z.number(), cached_input_tokens: z.number(), output_tokens: z.number() }),
  }),
  z.object({ type: z.literal("turn.failed"), error: z.object({ message: z.string() }) }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

const compactCodexItem = (
  item: z.infer<typeof CodexStartedItemSchema> | z.infer<typeof CodexCompletedItemSchema>,
): string | null => {
  switch (item.type) {
    case "command_execution":
      return `[command] ${oneLine(item.command)}`;
    case "mcp_tool_call":
      return toolCall(`${item.server}.${item.tool}`, item.arguments);
    case "agent_message":
      return item.text.trim() === "" ? null : item.text.trim();
    case "file_change":
      return `[file_change] ${oneLine(item.changes.map(({ kind, path }) => `${kind} ${path}`).join(", "))}`;
    case "web_search":
      return `[web_search] ${oneLine(item.query)}`;
  }
};

const compactCodex = (line: unknown): string | null => {
  const parsed = CodexLineSchema.safeParse(line);
  if (!parsed.success) return null;
  const event = parsed.data;
  switch (event.type) {
    case "item.started":
    case "item.completed":
      return compactCodexItem(event.item);
    case "turn.completed": {
      const { input_tokens, cached_input_tokens, output_tokens } = event.usage;
      return `[result] ${tokens({ input: input_tokens, cacheRead: cached_input_tokens, output: output_tokens })}`;
    }
    case "turn.failed":
      return `[error] ${oneLine(event.error.message)}`;
    case "error":
      return `[error] ${oneLine(event.message)}`;
  }
};

const COMPACTORS: Record<Harness, Compactor | null> = {
  ClaudeCode: compactClaudeCode,
  Codex: compactCodex,
  OpenCode: compactOpenCode,
  PiDev: compactPi,
  MistralAgent: null,
};

export const compactorOf = (harness: Harness): Compactor | null => COMPACTORS[harness];
