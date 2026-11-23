import assert from "node:assert/strict";
import { test } from "node:test";
import { stampTurnPoints } from "../src/turn-metrics.ts";

const point = (metric: string, turnId: string, dimensions: Record<string, string>) => ({
  metric,
  at: "2026-11-17T12:00:00+01:00",
  value: 1,
  dimensions,
  turnId,
  sessionId: "session-1",
});

test("turn points get the signed host over a forged one, and a not reported turn keeps its tokens and loses its cost", () => {
  const stamped = stampTurnPoints(
    [
      point("turn.cost", "billed", { hostId: "forged", costBasis: "NotBilled" }),
      point("turn.tokens", "tokensOnly", { tokenKind: "Input", costBasis: "NotReported" }),
      point("turn.cost", "tokensOnly", { costBasis: "NotReported" }),
      point("turn.phase", "billed", { phase: "Boot" }),
    ],
    "host-1",
  );
  assert.deepEqual(
    stamped.map((each) => [each.metric, each.turnId, each.dimensions]),
    [
      ["turn.cost", "billed", { costBasis: "NotBilled", hostId: "host-1" }],
      ["turn.tokens", "tokensOnly", { tokenKind: "Input", costBasis: "NotReported", hostId: "host-1" }],
      ["turn.phase", "billed", { phase: "Boot", hostId: "host-1" }],
    ],
  );
});
