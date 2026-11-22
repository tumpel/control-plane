import { z } from "zod";
import type { Env } from "./index";
import { pruneReleases } from "./release-prune";
import { CURRENT_RELEASE_KEY, readRelease } from "./releases";

const ObjectEventSchema = z.object({ object: z.object({ key: z.string() }) });

const keyOf = (body: unknown): string => {
  const parsed = ObjectEventSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `a release bucket event carries no object key: ${JSON.stringify(body)}; check the event notification of the release bucket in packages/control-plane/infra`,
    );
  }
  return parsed.data.object.key;
};

const onlineHosts = async (db: D1Database): Promise<string[]> => {
  const { results } = await db.prepare("SELECT host_id FROM hosts WHERE state = 'Online'").all<{ host_id: string }>();
  return results.map((row) => row.host_id);
};

export const noticeRelease = async (env: Env, bodies: unknown[], now: number): Promise<void> => {
  if (!bodies.map(keyOf).includes(CURRENT_RELEASE_KEY)) return;
  const release = await readRelease(env.RELEASES, now);
  if (release.kind === "Unpublished") {
    throw new Error(`the release bucket announced ${CURRENT_RELEASE_KEY} and holds none; publish the release again`);
  }
  if (release.kind === "Unreadable") throw new Error(`${release.detail}; publish the release again`);
  const { releaseVersion } = release.manifest;
  const hosts = await onlineHosts(env.DB);
  await Promise.all(hosts.map((hostId) => env.HOST.get(env.HOST.idFromName(hostId)).releasePublished(releaseVersion)));
  await pruneReleases(env.RELEASES, releaseVersion, release.stored, now);
};
