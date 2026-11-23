import type { TurnPointSchema } from "@tumpel/schemas";
import type { z } from "zod";

type TurnPoint = z.infer<typeof TurnPointSchema>;

export const stampTurnPoints = (turns: readonly TurnPoint[], hostId: string): TurnPoint[] =>
  turns.flatMap((point) => {
    const dimensions: Record<string, string> = { ...point.dimensions, hostId };
    if (point.metric === "turn.cost" && dimensions.costBasis === "NotReported") return [];
    return [{ ...point, dimensions }];
  });
