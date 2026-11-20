import type { TurnSchema } from "@tumpel/schemas";
import { z } from "zod";
import { readSignedState, signState } from "./github.ts";

export const TUMPEL_CONNECTOR_ID = "tumpel";
export const TURN_TOKEN_SIGNING_PURPOSE = "tumpel-turn-token-v1";

const PREFIX = "tumpel-turn_";

const TurnClaimsSchema = z.object({
  tenantId: z.string().min(1),
  principalId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  expiresAt: z.number().int(),
});
type TurnClaims = z.infer<typeof TurnClaimsSchema>;

export const mintTurnToken = async (key: CryptoKey, claims: TurnClaims): Promise<string> =>
  `${PREFIX}${await signState(key, claims)}`;

export const verifyTurnToken = async (key: CryptoKey, token: string, now: number): Promise<TurnClaims | null> => {
  if (!token.startsWith(PREFIX)) return null;
  const read = await readSignedState(key, token.slice(PREFIX.length), TurnClaimsSchema);
  if (!read.ok || read.claims.expiresAt <= now) return null;
  return read.claims;
};

export type LiveTurn = Pick<z.infer<typeof TurnSchema>, "sessionId" | "state">;

export const turnTokenLive = (claims: TurnClaims, turn: LiveTurn | null): boolean =>
  turn?.state === "Running" && turn.sessionId === claims.sessionId;
