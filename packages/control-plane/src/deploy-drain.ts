import { DeployDrainSchema, type ReleaseRolloutSchema } from "@tumpel/schemas";
import type { z } from "zod";
import { sameSecret } from "./crypto";
import { issues, json, type Problem, problem } from "./http";
import { bearerOf } from "./identity";
import type { Env } from "./index";
import { tenantApi } from "./tenant-api.ts";

export type ReleaseRollout = z.infer<typeof ReleaseRolloutSchema>;
export type RunningTurns = { hostId: string; runningTurns: number };

export const DEPLOY_DRAIN_KEY = "deploy-drain.json";

export interface DrainBucket {
  head(key: string): Promise<unknown>;
}

export const deployDraining = async (bucket: DrainBucket): Promise<boolean> =>
  (await bucket.head(DEPLOY_DRAIN_KEY)) !== null;

export const deployInProgress = (retry: string): Problem => ({
  code: "DeployInProgress",
  title: "Deploy in progress",
  detail: "a deploy of the control plane is in progress, so no new session or turn starts until it ends",
  fix: `Once the dashboard shows the new release, ${retry}`,
});

const tokenRefused = (): Response =>
  problem(
    401,
    {
      code: "DeployDrainTokenRefused",
      title: "Deploy drain token refused",
      detail: `the bearer is not the drainToken of ${DEPLOY_DRAIN_KEY} in the release bucket`,
      fix: "Read the rollout with the drainToken that npm run deploy:drain -- start wrote",
    },
    { "www-authenticate": "Bearer" },
  );

const drainToken = (text: string): string => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${DEPLOY_DRAIN_KEY} in the release bucket is not JSON (${String(error)}); start the drain again with npm run deploy:drain -- start`,
    );
  }
  const parsed = DeployDrainSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${DEPLOY_DRAIN_KEY} in the release bucket does not match DeployDrain in typespec/lib/release.tsp: ${issues(parsed.error)}; start the drain again with npm run deploy:drain -- start`,
    );
  }
  return parsed.data.drainToken;
};

export const handleReleaseRollout = async (request: Request, _url: URL, env: Env): Promise<Response> => {
  const object = await env.RELEASES.get(DEPLOY_DRAIN_KEY);
  if (object === null) {
    return problem(404, {
      code: "NotFound",
      title: "No deploy drain",
      detail: `the release bucket holds no ${DEPLOY_DRAIN_KEY}, so no deploy drain runs`,
      fix: "Start the drain with npm run deploy:drain -- start, then read the rollout again",
    });
  }
  if (!sameSecret(bearerOf(request), drainToken(await object.text()))) return tokenRefused();
  const { results } = await env.DB.prepare("SELECT DISTINCT tenant_id FROM hosts").all<{ tenant_id: string }>();
  const hosts = (
    await Promise.all(
      results.map(async ({ tenant_id }) =>
        (
          await tenantApi(env.TENANT, tenant_id).call("runningTurnsByHost", {})
        ).running.map((each) => ({
          ...each,
          tenantId: tenant_id,
        })),
      ),
    )
  ).flat();
  const rollout: ReleaseRollout = { deployedCommit: env.DEPLOYED_COMMIT, drained: hosts.length === 0, hosts };
  return json(rollout);
};
