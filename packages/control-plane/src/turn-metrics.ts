import type { CredentialCheck, SecretMember } from "@tumpel/api/credentials";
import type { MetricBatchSchema, TurnPointSchema } from "@tumpel/schemas";
import { z } from "zod";

type TurnPoint = z.infer<typeof TurnPointSchema>;
export type Dimensions = Record<string, string>;

const SPEND_METRICS = new Set(["turn.cost", "turn.tokens"]);

export const DimensionsSchema = z.record(z.string(), z.string());

export const offeredDimensions = (
  personaId: string,
  secretSetId: string,
  credential: CredentialCheck<SecretMember> | null,
): Dimensions => ({
  personaId,
  secretSetId,
  ...(credential?.kind === "Usable"
    ? { provider: credential.credential.provider, costBasis: credential.costBasis }
    : {}),
});

export const stampTurnPoints = (
  turns: readonly TurnPoint[],
  offered: Readonly<Record<string, Dimensions>>,
  hostId: string,
): TurnPoint[] =>
  turns.flatMap((point) => {
    const spend: Dimensions = SPEND_METRICS.has(point.metric) ? (offered[point.turnId] ?? {}) : {};
    const dimensions: Dimensions = { ...point.dimensions, ...spend, hostId };
    if (point.metric === "turn.cost" && dimensions.costBasis === "NotReported") return [];
    return [{ ...point, dimensions }];
  });

const TIMING_DESCRIPTIONS = {
  "turn.image_fetch.duration": "Seconds from the host reporting an image fetch to its next message for the turn",
  "turn.first_output.duration": "Seconds from the claim to the turn's first transcript line",
} as const;

export type TimingMetric = keyof typeof TIMING_DESCRIPTIONS;

export const timingBatch = (
  metric: TimingMetric,
  point: { turnId: string; sessionId: string; dimensions: Dimensions },
  startedAt: number,
  endedAt: number,
): z.infer<typeof MetricBatchSchema> => ({
  instruments: [{ metric, unit: "s", kind: "Turn", description: TIMING_DESCRIPTIONS[metric] }],
  samples: [],
  turns: [{ metric, at: new Date(endedAt).toISOString(), value: (endedAt - startedAt) / 1000, ...point }],
});
