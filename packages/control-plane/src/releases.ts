import { ChannelProtocol, type HostArchitectureSchema, ReleaseManifestSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { issues } from "./http.ts";

export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
export type ReleaseImage = ReleaseManifest["images"][number];
export type ReleaseSupervisor = ReleaseManifest["supervisors"][number];
export type HostArchitecture = z.infer<typeof HostArchitectureSchema>;

export interface ReleaseBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export type ReleaseRead = { kind: "Published"; manifest: ReleaseManifest } | { kind: "Unpublished" };

export const CURRENT_RELEASE_KEY = "current.json";
export const RELEASE_CACHE_MS = 30_000;

const republish = "publish the release again with the release workflow";

const arch = (architecture: HostArchitecture): string => architecture.toLowerCase();

export const supervisorKey = (supervisor: ReleaseSupervisor): string =>
  `supervisor/${arch(supervisor.architecture)}/${supervisor.sha256}`;

const imagePrefix = (image: ReleaseImage): string =>
  `images/${image.harness}/${image.harnessVersion}/${arch(image.architecture)}`;

export const imageKey = (image: ReleaseImage): string => `${imagePrefix(image)}/${image.imageDigest}`;

export const manifestKey = (image: ReleaseImage): string => `${imagePrefix(image)}/${image.manifestDigest}`;

export const kernelKey = (image: ReleaseImage): string => `kernels/${arch(image.architecture)}/${image.kernelDigest}`;

const duplicates = (keys: string[]): string[] => [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];

export const parseRelease = (text: string): ReleaseManifest => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${CURRENT_RELEASE_KEY} in the release bucket is not JSON (${String(error)}); ${republish}`);
  }
  const parsed = ReleaseManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${CURRENT_RELEASE_KEY} in the release bucket does not match ReleaseManifest in packages/api/release.tsp: ${issues(parsed.error)}; ${republish}`,
    );
  }
  const manifest = parsed.data;
  if (manifest.channelProtocolVersion !== ChannelProtocol.Version) {
    throw new Error(
      `${CURRENT_RELEASE_KEY} of release ${manifest.releaseVersion} is built for channel protocol version ${manifest.channelProtocolVersion}, and this control plane speaks ${ChannelProtocol.Version}; ${republish} from the commit this control plane is deployed from`,
    );
  }
  const repeated = [
    ...duplicates(manifest.supervisors.map((supervisor) => supervisor.architecture)).map(
      (architecture) => `two supervisors for ${architecture}`,
    ),
    ...duplicates(manifest.images.map((image) => `${image.harness} ${image.harnessVersion} ${image.architecture}`)).map(
      (image) => `two images for ${image}`,
    ),
  ];
  if (repeated.length > 0) {
    throw new Error(
      `${CURRENT_RELEASE_KEY} of release ${manifest.releaseVersion}: ${repeated.join("; ")}; ${republish}`,
    );
  }
  return manifest;
};

let cached: { readAt: number; manifest: ReleaseManifest } | undefined;

export const currentRelease = async (bucket: ReleaseBucket, now: number): Promise<ReleaseRead> => {
  if (cached !== undefined && now - cached.readAt < RELEASE_CACHE_MS) {
    return { kind: "Published", manifest: cached.manifest };
  }
  const object = await bucket.get(CURRENT_RELEASE_KEY);
  if (object === null) return { kind: "Unpublished" };
  const manifest = parseRelease(await object.text());
  cached = { readAt: now, manifest };
  return { kind: "Published", manifest };
};

export const imagesFor = (release: ReleaseRead, harness: string, harnessVersion: string): ReleaseImage[] =>
  release.kind === "Published"
    ? release.manifest.images.filter((image) => image.harness === harness && image.harnessVersion === harnessVersion)
    : [];
