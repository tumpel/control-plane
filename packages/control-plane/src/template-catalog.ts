import type {
  PrebuildTemplateManifestSchema,
  PrebuildTemplateSchema,
  PrebuildTemplateToolchainSchema,
} from "@tumpel/schemas";
import { PrebuildTemplateVersionSchema } from "@tumpel/schemas";
import { z } from "zod";
import type { Toolchain } from "./guest-toolchains.ts";

export type PrebuildTemplate = z.infer<typeof PrebuildTemplateSchema>;
export type PrebuildTemplateVersion = z.infer<typeof PrebuildTemplateVersionSchema>;
export type PrebuildTemplateManifest = z.infer<typeof PrebuildTemplateManifestSchema>;
type TemplateToolchain = z.infer<typeof PrebuildTemplateToolchainSchema>;

export const RecordedVersionsSchema = z.array(
  PrebuildTemplateVersionSchema.pick({ prebuildTemplateId: true, prebuildTemplateVersion: true, digest: true }),
);

export type RecordedVersion = z.infer<typeof RecordedVersionsSchema>[number];

export interface DiskVersion extends RecordedVersion {
  toolchains: TemplateToolchain[];
}

export type VersionLookup = { kind: "Found"; version: PrebuildTemplateVersion } | { kind: "NotFound"; detail: string };

const newestFirst = (a: { prebuildTemplateVersion: number }, b: { prebuildTemplateVersion: number }): number =>
  b.prebuildTemplateVersion - a.prebuildTemplateVersion;

const templateIds = (versions: readonly RecordedVersion[]): string[] =>
  [...new Set(versions.map((version) => version.prebuildTemplateId))].sort();

export const catalog = (shipped: readonly PrebuildTemplateVersion[]): PrebuildTemplate[] =>
  templateIds(shipped).map((prebuildTemplateId) => ({
    prebuildTemplateId,
    versions: shipped
      .filter((version) => version.prebuildTemplateId === prebuildTemplateId)
      .sort(newestFirst)
      .map(({ prebuildTemplateId: _, devcontainer: __, ...summary }) => summary),
  }));

export const findVersion = (
  shipped: readonly PrebuildTemplateVersion[],
  prebuildTemplateId: string,
  prebuildTemplateVersion: number,
): VersionLookup => {
  const versions = shipped.filter((version) => version.prebuildTemplateId === prebuildTemplateId).sort(newestFirst);
  if (versions.length === 0)
    return {
      kind: "NotFound",
      detail: `no template is called ${prebuildTemplateId}; the templates are ${templateIds(shipped).join(", ")}`,
    };
  const found = versions.find((version) => version.prebuildTemplateVersion === prebuildTemplateVersion);
  if (found !== undefined) return { kind: "Found", version: found };
  return {
    kind: "NotFound",
    detail: `template ${prebuildTemplateId} has no version ${prebuildTemplateVersion}; its versions are ${versions.map((version) => version.prebuildTemplateVersion).join(", ")}`,
  };
};

const key = (version: RecordedVersion): string => `${version.prebuildTemplateId}/${version.prebuildTemplateVersion}`;

const toolchainProblems = (newest: DiskVersion, guest: Readonly<Record<Toolchain, string>>): string[] =>
  newest.toolchains
    .filter(({ toolchain, toolchainVersion }) => guest[toolchain] !== toolchainVersion)
    .map(
      ({ toolchain, toolchainVersion }) =>
        `the newest ${newest.prebuildTemplateId} version, ${newest.prebuildTemplateVersion}, pins ${toolchain} ${toolchainVersion} and the guest image carries ${toolchain} ${guest[toolchain]}; add a version that pins ${guest[toolchain]}`,
    );

export const recordProblems = (
  recorded: readonly RecordedVersion[],
  onDisk: readonly DiskVersion[],
  guest: Readonly<Record<Toolchain, string>>,
): string[] => {
  const disk = new Map(onDisk.map((version) => [key(version), version]));
  const record = new Set(recorded.map(key));
  const kept = recorded.flatMap((version) => {
    const found = disk.get(key(version));
    if (found === undefined)
      return [
        `${key(version)} is recorded in versions.json and missing from templates; a shipped version never goes away, so restore it`,
      ];
    if (found.digest !== version.digest)
      return [
        `${key(version)} changed: versions.json records ${version.digest} and its devcontainer.jsonc is ${found.digest}; a shipped version never changes, so restore the file and add the change as a new version`,
      ];
    return [];
  });
  const unrecorded = onDisk
    .filter((version) => !record.has(key(version)))
    .map((version) => `${key(version)} is not in versions.json; record it with digest ${version.digest}`);
  const toolchains = templateIds(onDisk).flatMap((prebuildTemplateId) => {
    const [newest] = onDisk.filter((version) => version.prebuildTemplateId === prebuildTemplateId).sort(newestFirst);
    return newest === undefined ? [] : toolchainProblems(newest, guest);
  });
  return [...kept, ...unrecorded, ...toolchains];
};
