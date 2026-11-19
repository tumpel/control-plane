import assert from "node:assert/strict";
import { test } from "node:test";
import { checkModelCredential, type SecretMember } from "@tumpel/api/credentials";
import { HARNESS_CATALOG } from "../src/harness-catalog.ts";
import { offeredDimensions, stampTurnPoints } from "../src/turn-metrics.ts";

const NOW = Date.parse("2026-11-17T12:00:00+01:00");

const entry = (harness: string) => {
  const found = HARNESS_CATALOG.find((each) => each.harness === harness);
  assert.ok(found, harness);
  return found;
};

const offered = (harness: string, member: SecretMember, model: string) =>
  offeredDimensions("persona-1", "set-1", checkModelCredential(entry(harness), [member], model, NOW));

const point = (metric: string, turnId: string, dimensions: Record<string, string>) => ({
  metric,
  at: "2026-11-17T12:00:00+01:00",
  value: 1,
  dimensions,
  turnId,
  sessionId: "session-1",
});

test("a subscription turn's cost is not billed, an API key's is billed, and a list price the provider does not charge is not reported", () => {
  const subscription: SecretMember = {
    kind: "SubscriptionToken",
    name: "CLAUDE",
    provider: "Anthropic",
    expiresAt: "2027-11-17T12:00:00+01:00",
    value: "oauth",
  };
  const apiKey: SecretMember = { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: "sk-ant" };
  const openRouter: SecretMember = { kind: "ApiKey", name: "OPENROUTER", provider: "OpenRouter", value: "sk-or" };
  const chatGpt: SecretMember = {
    kind: "CredentialFile",
    name: "CODEX_AUTH_JSON",
    provider: "OpenAi",
    expiresAt: "2027-11-17T12:00:00+01:00",
    value: "{}",
  };
  assert.deepEqual(offered("ClaudeCode", subscription, "claude-opus-5-5"), {
    personaId: "persona-1",
    secretSetId: "set-1",
    provider: "Anthropic",
    costBasis: "NotBilled",
  });
  assert.equal(offered("ClaudeCode", apiKey, "claude-opus-5-5").costBasis, "Billed");
  assert.equal(offered("ClaudeCode", openRouter, "anthropic/claude-opus-5-5").costBasis, "NotReported");
  assert.equal(offered("Codex", chatGpt, "gpt-5.5").costBasis, "NotReported");
  assert.deepEqual(offeredDimensions("persona-1", "set-1", null), { personaId: "persona-1", secretSetId: "set-1" });
});

test("spend points get the turn's offered dimensions and the signed host, and a not reported turn keeps its tokens and loses its cost", () => {
  const dimensions = {
    billed: { personaId: "p", secretSetId: "s", provider: "Anthropic", costBasis: "NotBilled" },
    tokensOnly: { personaId: "p", secretSetId: "s", provider: "OpenAi", costBasis: "NotReported" },
  };
  const stamped = stampTurnPoints(
    [
      point("turn.cost", "billed", { hostId: "forged" }),
      point("turn.tokens", "tokensOnly", { tokenKind: "Input" }),
      point("turn.cost", "tokensOnly", {}),
      point("turn.phase", "billed", { phase: "Boot" }),
    ],
    dimensions,
    "host-1",
  );
  assert.deepEqual(
    stamped.map((each) => [each.metric, each.turnId, each.dimensions]),
    [
      ["turn.cost", "billed", { ...dimensions.billed, hostId: "host-1" }],
      ["turn.tokens", "tokensOnly", { tokenKind: "Input", ...dimensions.tokensOnly, hostId: "host-1" }],
      ["turn.phase", "billed", { phase: "Boot", hostId: "host-1" }],
    ],
  );
});
