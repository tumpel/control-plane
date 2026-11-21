import assert from "node:assert/strict";
import { test } from "node:test";
import { offeredDimensions, stampTurnPoints } from "../src/turn-metrics.ts";

const point = (metric: string, turnId: string, dimensions: Record<string, string>) => ({
  metric,
  at: "2026-11-17T12:00:00+01:00",
  value: 1,
  dimensions,
  turnId,
  sessionId: "session-1",
});

test("a turn offers its persona and secret set as dimensions", () => {
  assert.deepEqual(offeredDimensions("persona-1", "set-1"), { personaId: "persona-1", secretSetId: "set-1" });
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
