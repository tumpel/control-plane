import type { CredentialCheck, SecretMember } from "@tumpel/api/credentials";
import type { TurnPointSchema } from "@tumpel/schemas";
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
