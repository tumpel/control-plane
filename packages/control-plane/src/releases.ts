import { type HostArchitectureSchema, ReleaseManifestSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import type { BootImage } from "./channel/protocol.ts";
import { issues, type Problem } from "./http.ts";
import type { Signer } from "./presign.ts";

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
export type ReleaseImage = ReleaseManifest["images"][number];
export type ReleaseBaseImage = ReleaseManifest["bases"][number];
export type ReleaseHarnessLayer = ReleaseManifest["harnessLayers"][number];
export type ReleaseSupervisor = ReleaseManifest["supervisors"][number];
export type ReleaseCli = ReleaseManifest["clis"][number];
export type HostArchitecture = z.infer<typeof HostArchitectureSchema>;

export interface ReleaseBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export type ReleaseRead = { kind: "Published"; manifest: ReleaseManifest } | { kind: "Unpublished" };

export type ReleaseLookup = ReleaseRead | { kind: "Unreadable"; detail: string };

export const CURRENT_RELEASE_KEY = "current.json";
export const RELEASE_CACHE_MS = 30_000;

const arch = (architecture: HostArchitecture): string => architecture.toLowerCase();

export const supervisorKey = (supervisor: ReleaseSupervisor): string =>
  `supervisor/${arch(supervisor.architecture)}/${supervisor.sha256}`;

export const cliKey = (cli: ReleaseCli): string => `cli/${arch(cli.architecture)}/${cli.sha256}`;

const imagePrefix = (image: ReleaseImage): string =>
  `images/${image.harness}/${image.harnessVersion}/${arch(image.architecture)}`;

export const imageKey = (image: ReleaseImage): string => `${imagePrefix(image)}/${image.imageDigest}`;

export const manifestKey = (image: ReleaseImage): string => `${imagePrefix(image)}/${image.manifestDigest}`;

export const rootfsKey = (image: ReleaseImage): string => `${imagePrefix(image)}/rootfs/${image.rootfsDigest}`;

export const kernelKey = (image: ReleaseImage | ReleaseBaseImage): string =>
  `kernels/${arch(image.architecture)}/${image.kernelDigest}`;

const basePrefix = (base: ReleaseBaseImage): string => `images/base/${arch(base.architecture)}`;

const layerPrefix = (layer: ReleaseHarnessLayer): string =>
  `layers/${layer.harness}/${layer.harnessVersion}/${arch(layer.architecture)}`;

const duplicates = (keys: string[]): string[] => [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];

export type ReleaseParse = { ok: true; manifest: ReleaseManifest } | { ok: false; detail: string };

export const parseRelease = (text: string): ReleaseParse => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, detail: `${CURRENT_RELEASE_KEY} in the release bucket is not JSON (${String(error)})` };
  }
  const parsed = ReleaseManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `${CURRENT_RELEASE_KEY} in the release bucket does not match ReleaseManifest in packages/api/release.tsp: ${issues(parsed.error)}`,
    };
  }
  const manifest = parsed.data;
  const repeated = [
    ...duplicates(manifest.supervisors.map((supervisor) => supervisor.architecture)).map(
      (architecture) => `two supervisors for ${architecture}`,
    ),
    ...duplicates(manifest.clis.map((cli) => cli.architecture)).map((architecture) => `two CLIs for ${architecture}`),
    ...duplicates(manifest.images.map((image) => `${image.harness} ${image.harnessVersion} ${image.architecture}`)).map(
      (image) => `two images for ${image}`,
    ),
  ];
  if (repeated.length > 0) {
    return {
      ok: false,
      detail: `${CURRENT_RELEASE_KEY} of release ${manifest.releaseVersion}: ${repeated.join("; ")}`,
    };
  }
  return { ok: true, manifest };
};

let cached: { readAt: number; manifest: ReleaseManifest } | undefined;

export const readRelease = async (bucket: ReleaseBucket, now: number): Promise<ReleaseLookup> => {
  if (cached !== undefined && now - cached.readAt < RELEASE_CACHE_MS) {
    return { kind: "Published", manifest: cached.manifest };
  }
  const object = await bucket.get(CURRENT_RELEASE_KEY);
  if (object === null) return { kind: "Unpublished" };
  const parsed = parseRelease(await object.text());
  if (!parsed.ok) return { kind: "Unreadable", detail: parsed.detail };
  cached = { readAt: now, manifest: parsed.manifest };
  return { kind: "Published", manifest: parsed.manifest };
};

export const releaseUnreadable = (detail: string, retry: string): Problem => ({
  code: "ImageNotReleased",
  title: "The published release is unreadable",
  detail: `the published release is unreadable: ${detail}`,
  fix: `Ask the operator to publish a release with the release workflow, then ${retry}`,
});

export const imagesFor = (release: ReleaseRead, harness: string, harnessVersion: string): ReleaseImage[] =>
  release.kind === "Published"
    ? release.manifest.images.filter((image) => image.harness === harness && image.harnessVersion === harnessVersion)
    : [];

export type ReleasedBoot =
  | { kind: "Layered"; base: ReleaseBaseImage; layer: ReleaseHarnessLayer }
  | { kind: "Full"; image: ReleaseImage };

export const bootFor = (
  release: ReleaseRead,
  harness: string,
  harnessVersion: string,
  architecture: HostArchitecture,
): ReleasedBoot | undefined => {
  if (release.kind !== "Published") return undefined;
  const base = release.manifest.bases.find((each) => each.architecture === architecture);
  const layer = release.manifest.harnessLayers.find(
    (each) => each.harness === harness && each.harnessVersion === harnessVersion && each.architecture === architecture,
  );
  if (base !== undefined && layer !== undefined) return { kind: "Layered", base, layer };
  const image = imagesFor(release, harness, harnessVersion).find((each) => each.architecture === architecture);
  return image === undefined ? undefined : { kind: "Full", image };
};

export const bootArchitectures = (
  release: ReleaseRead,
  harness: string,
  harnessVersion: string,
): HostArchitecture[] => {
  if (release.kind !== "Published") return [];
  const listed = [...release.manifest.images, ...release.manifest.bases].map((each) => each.architecture);
  return [...new Set(listed)].filter(
    (architecture) => bootFor(release, harness, harnessVersion, architecture) !== undefined,
  );
};

export const bootImage = async (
  signer: Signer,
  boot: ReleasedBoot,
  urlSeconds: number,
  fetchSeconds: number,
  now: number,
): Promise<BootImage> => {
  const at = new Date(now);
  const get = (key: string): Promise<string> => signer.presign("GET", key, urlSeconds, at);
  const downloadExpiresAt = new Date(now + urlSeconds * 1000).toISOString();
  if (boot.kind === "Full") {
    const { image } = boot;
    return {
      kind: "Full",
      imageDigest: image.imageDigest,
      kernelDigest: image.kernelDigest,
      manifestDigest: image.manifestDigest,
      imageUrl: await get(imageKey(image)),
      kernelUrl: await get(kernelKey(image)),
      manifestUrl: await get(manifestKey(image)),
      downloadExpiresAt,
      fetchSeconds,
    };
  }
  const { base, layer } = boot;
  return {
    kind: "Layered",
    base: {
      imageDigest: base.imageDigest,
      kernelDigest: base.kernelDigest,
      manifestDigest: base.manifestDigest,
      imageUrl: await get(`${basePrefix(base)}/${base.imageDigest}`),
      kernelUrl: await get(kernelKey(base)),
      manifestUrl: await get(`${basePrefix(base)}/${base.manifestDigest}`),
    },
    layer: {
      layer,
      layerUrl: await get(`${layerPrefix(layer)}/${layer.layerDigest}`),
      manifestUrl: await get(`${layerPrefix(layer)}/${layer.manifestDigest}`),
    },
    downloadExpiresAt,
    fetchSeconds,
  };
};
