import { ImageReleaseSchema, ReleaseHarnessLayerSchema } from "@tumpel/schemas";
import { z } from "zod";
import {
  basePrefix,
  imageKey,
  imagePrefix,
  kernelKey,
  layerPrefix,
  manifestKey,
  parseRelease,
  type ReleaseBaseImage,
  type ReleaseHarnessLayer,
  type ReleaseImage,
  rootfsKey,
} from "./releases.ts";

export const RELEASES_KEPT = 5;
export const ARTIFACT_GRACE_MS = 24 * 60 * 60 * 1000;

const RELEASE_HISTORY_PREFIX = "releases/";
const IMAGE_RELEASE_KEY = "images.json";
const ARTIFACT_PREFIXES = ["images/", "kernels/", "layers/", "oci/"];
const DELETE_BATCH = 1000;

const OciManifestSchema = z.object({
  config: z.object({ digest: z.string() }),
  layers: z.array(z.object({ digest: z.string() })),
});

type Listed = { key: string; uploaded: Date };

export interface PrunedBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
  list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{ objects: Listed[]; truncated: boolean; cursor?: string }>;
  delete(keys: string[]): Promise<void>;
}

type Released = { images: ReleaseImage[]; bases: ReleaseBaseImage[]; harnessLayers: ReleaseHarnessLayer[] };

const listAll = async (bucket: PrunedBucket, prefix: string): Promise<Listed[]> => {
  const objects: Listed[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return objects;
};

const textOf = async (bucket: PrunedBucket, key: string): Promise<string> => {
  const object = await bucket.get(key);
  if (object === null) throw new Error(`the release bucket holds no ${key}; publish the release again`);
  return object.text();
};

const ociKeys = async (bucket: PrunedBucket, prefix: string, ociDigest: string): Promise<string[]> => {
  const key = `${prefix}/${ociDigest}`;
  const manifest = OciManifestSchema.parse(JSON.parse(await textOf(bucket, key)));
  const blob = (digest: string): string => `${prefix}/${digest.replace(/^sha256:/, "")}`;
  return [key, blob(manifest.config.digest), ...manifest.layers.map((layer) => blob(layer.digest))];
};

const releasedKeys = async (bucket: PrunedBucket, released: Released): Promise<string[]> => [
  ...released.images.flatMap((image) => [
    imageKey(image),
    manifestKey(image),
    `${imagePrefix(image)}/rootfs/${image.rootfsDigest}`,
    kernelKey(image),
  ]),
  ...released.bases.flatMap((base) => [
    `${basePrefix(base)}/${base.imageDigest}`,
    `${basePrefix(base)}/${base.manifestDigest}`,
    rootfsKey(base),
    kernelKey(base),
  ]),
  ...released.harnessLayers.flatMap((layer) => [
    `${layerPrefix(layer)}/${layer.layerDigest}`,
    `${layerPrefix(layer)}/${layer.manifestDigest}`,
  ]),
  ...(
    await Promise.all([
      ...released.images.map((image) =>
        ociKeys(
          bucket,
          `oci/${image.harness}/${image.harnessVersion}/${image.architecture.toLowerCase()}`,
          image.ociDigest,
        ),
      ),
      ...released.bases.map((base) => ociKeys(bucket, `oci/base/${base.architecture.toLowerCase()}`, base.ociDigest)),
    ])
  ).flat(),
];

const keptReleases = async (bucket: PrunedBucket): Promise<Released[]> => {
  const history = (await listAll(bucket, RELEASE_HISTORY_PREFIX))
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
    .slice(0, RELEASES_KEPT);
  const releases: Released[] = [];
  for (const { key } of history) {
    const parsed = parseRelease(await textOf(bucket, key));
    if (!parsed.ok) throw new Error(`${key}: ${parsed.detail}`);
    releases.push(parsed.manifest);
  }
  const staged = await bucket.get(IMAGE_RELEASE_KEY);
  if (staged === null) return releases;
  const { images, bases } = ImageReleaseSchema.parse(JSON.parse(await staged.text()));
  return [...releases, { images, bases, harnessLayers: [] }];
};

export const pruneReleases = async (
  bucket: PrunedBucket,
  releaseVersion: string,
  stored: string,
  now: number,
): Promise<string[]> => {
  await bucket.put(`${RELEASE_HISTORY_PREFIX}${releaseVersion}.json`, stored);
  const released = await keptReleases(bucket);
  const kept = new Set((await Promise.all(released.map((each) => releasedKeys(bucket, each)))).flat());
  const artifacts = (await Promise.all(ARTIFACT_PREFIXES.map((prefix) => listAll(bucket, prefix)))).flat();
  for (const recipe of artifacts.filter((object) => object.key.includes("/recipes/"))) {
    const layer = ReleaseHarnessLayerSchema.parse(JSON.parse(await textOf(bucket, recipe.key)));
    if (kept.has(`${layerPrefix(layer)}/${layer.layerDigest}`)) kept.add(recipe.key);
  }
  const dead = artifacts
    .filter((object) => !kept.has(object.key) && now - object.uploaded.getTime() > ARTIFACT_GRACE_MS)
    .map((object) => object.key);
  for (let start = 0; start < dead.length; start += DELETE_BATCH) {
    await bucket.delete(dead.slice(start, start + DELETE_BATCH));
  }
  return dead;
};
