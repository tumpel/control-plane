export const STEER_CONNECTOR_ID = "steer";
export const STEER_SETTINGS_PATH = ".claude/settings.json";
export const STEER_EVENT_HEADER = "x-tumpel-steer";

const FORWARDER_ROUTE = `http://127.0.0.1:47160/connectors/${STEER_CONNECTOR_ID}`;

export type SteerEvent = "PostToolUse" | "Stop";

export const isSteerEvent = (value: string): value is SteerEvent => value === "PostToolUse" || value === "Stop";

const hook = (event: SteerEvent) => ({
  hooks: [{ type: "command", command: `curl -fsS -X POST -H '${STEER_EVENT_HEADER}: ${event}' ${FORWARDER_ROUTE}` }],
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const steerSettings = (raw: string | null): string | null => {
  let settings: unknown = {};
  if (raw !== null) {
    try {
      settings = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObject(settings)) return null;
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) return null;
  const postToolUse = hooks.PostToolUse ?? [];
  const stop = hooks.Stop ?? [];
  if (!Array.isArray(postToolUse) || !Array.isArray(stop)) return null;
  return JSON.stringify({
    ...settings,
    hooks: { ...hooks, PostToolUse: [...postToolUse, hook("PostToolUse")], Stop: [...stop, hook("Stop")] },
  });
};

export const steerHookOutput = (event: SteerEvent, prompts: string[]): Record<string, unknown> => {
  if (prompts.length === 0) return {};
  const text = `The person steering this turn says:\n\n${prompts.join("\n\n")}`;
  if (event === "Stop") return { decision: "block", reason: text };
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } };
};
