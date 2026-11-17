import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReleaseManifestSchema } from "@tumpel/schemas";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const currentRelease = async (endpoint, stage) => {
  const url = `${endpoint}/v1/releases/current`;
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`GET ${url} answered ${response.status}: ${await response.text()}; publish a release to ${stage}`);
  return ReleaseManifestSchema.parse(await response.json());
};

export const cached = (path, digest) => existsSync(path) && sha256(readFileSync(path)) === digest;

export const fetchVerified = async (url, digest, path, fix, headers = {}) => {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}: ${await response.text()}`);
  const body = Buffer.from(await response.arrayBuffer());
  const actual = sha256(body);
  if (actual !== digest) throw new Error(`GET ${url} returned sha256 ${actual}, expected ${digest}; ${fix}`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
  return path;
};

export const downloadRelease = async ({ endpoint, stage, release, kind, entries, architecture, dir }) => {
  const entry = entries.find((each) => each.architecture === architecture);
  if (!entry) throw new Error(`release ${release.releaseVersion} on ${stage} carries no ${kind} for ${architecture}`);
  const path = join(dir, `${kind}-${architecture.toLowerCase()}-${entry.sha256}`);
  if (cached(path, entry.sha256)) return path;
  return fetchVerified(
    `${endpoint}/v1/releases/${kind}/${architecture}`,
    entry.sha256,
    path,
    `release ${release.releaseVersion} names ${entry.sha256}; publish the release again with the release workflow`,
  );
};
