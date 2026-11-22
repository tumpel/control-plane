import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import type { ControlPlaneSettingsSchema } from "@tumpel/schemas";
import type { z } from "zod";

export type Settings = z.infer<typeof ControlPlaneSettingsSchema>;

export const TEST_SETTINGS: Settings = {
  dispatchGrantTtlSeconds: 300,
  snapshotDeadlineSeconds: 900,
  turnOfferTtlSeconds: 60,
  turnImageFetchBudgetSeconds: 900,
  turnTotalBudgetSeconds: 3600,
  transcriptChunkLines: 64,
  claudeSetupUrlBudgetSeconds: 300,
  claudeSetupCodeBudgetSeconds: 600,
  claudeSetupMintBudgetSeconds: 120,
  claudeSetupMintGraceSeconds: 10,
  heartbeatIntervalSeconds: 1,
  heartbeatDeadlineSeconds: 3,
  devicePollIntervalSeconds: 1,
  deviceSlowDownStepSeconds: 1,
};

const POLL_MS = 50;
export const GIVE_UP_MS = 60_000;

export const until = async <T>(what: string, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > GIVE_UP_MS) assert.fail(`${what} did not happen; last read ${JSON.stringify(value)}`);
    await wait(POLL_MS);
  }
};

export const pollInterval = (intervalSeconds: number): Promise<void> => wait(intervalSeconds * 1000 + POLL_MS);
