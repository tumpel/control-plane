import { createHash } from "node:crypto";
import { exactChecks } from "./release-github.mjs";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;
const REPOSITORY = "tumpel/dashboard";

export const compareVersions = (left, right) => {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  if (!a || !b) throw new Error("Dashboard version is invalid; use X.Y.Z or X.Y.Z-rc.N.");
  for (let i = 1; i <= 3; i += 1) {
    if (BigInt(a[i]) < BigInt(b[i])) return -1;
    if (BigInt(a[i]) > BigInt(b[i])) return 1;
  }
  if (a[4] === undefined || b[4] === undefined) return Number(a[4] === undefined) - Number(b[4] === undefined);
  return BigInt(a[4]) < BigInt(b[4]) ? -1 : BigInt(a[4]) > BigInt(b[4]) ? 1 : 0;
};

export const dashboardAssets = (version) =>
  Object.fromEntries(
    ["dashboard", "pages"].map((name) => [
      name,
      `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}-${version}.tgz`,
    ]),
  );

export const dashboardVersion = (url) => {
  const match =
    /^https:\/\/github\.com\/tumpel\/dashboard\/releases\/download\/v([^/]+)\/(dashboard|pages)-\1\.tgz$/.exec(url);
  if (!match || !VERSION.test(match[1]))
    throw new Error("Dashboard dependency URL is invalid; pin a published dashboard release.");
  return match[1];
};

export const dashboardReleaseEvent = (event) => {
  if (
    event?.component !== "dashboard" ||
    event.repository !== REPOSITORY ||
    typeof event.sha !== "string" ||
    !/^[0-9a-f]{40}$/.test(event.sha) ||
    typeof event.tag !== "string" ||
    !event.tag.startsWith("v") ||
    !VERSION.test(event.tag.slice(1))
  )
    throw new Error(
      "Dashboard dispatch provenance is invalid; send the published repository, source SHA and version tag.",
    );
  const version = event.tag.slice(1);
  const urls = dashboardAssets(version);
  const expected = Object.values(urls)
    .flatMap((url) => [url, `${url}.sha256`])
    .sort();
  if (!Array.isArray(event.assets) || JSON.stringify([...event.assets].sort()) !== JSON.stringify(expected))
    throw new Error("Dashboard dispatch assets differ from the release; dispatch both tarballs and their checksums.");
  return { version, sha: event.sha, urls };
};

export const verifyDashboardProvenance = (release, { commit, ancestry, published }) => {
  if (commit.sha !== release.sha)
    throw new Error("Dashboard tag differs from its source SHA; publish the exact checked commit.");
  if (!["ahead", "identical"].includes(ancestry.status))
    throw new Error("Dashboard source is outside main; release a checked main commit.");
  if (published.draft !== false || !published.published_at || published.tag_name !== `v${release.version}`)
    throw new Error("Dashboard release is unpublished; finish publication before dispatching.");
  const expected = Object.values(release.urls).flatMap((url) => [url, `${url}.sha256`]);
  for (const url of expected) {
    if (!published.assets.some((asset) => asset.browser_download_url === url && asset.state === "uploaded"))
      throw new Error(`Dashboard release lacks ${url}; publish every asset before dispatching.`);
  }
};

export const dashboardIntegrity = (url, bytes, checksum) => {
  const filename = url.split("/").at(-1);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (checksum.trim() !== `${digest}  ${filename}`)
    throw new Error(`Dashboard checksum failed for ${filename}; publish matching tarball bytes and checksum.`);
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
};

export const verifyDashboardRelease = async ({ event, github, download }) => {
  const release = dashboardReleaseEvent(event);
  const commit = await github(`/repos/${REPOSITORY}/commits/${event.tag}`);
  const ancestry = await github(`/repos/${REPOSITORY}/compare/${release.sha}...main`);
  const published = await github(`/repos/${REPOSITORY}/releases/tags/${event.tag}`);
  verifyDashboardProvenance(release, { commit, ancestry, published });
  await exactChecks(github, REPOSITORY, release.sha);
  const integrity = {};
  for (const [name, url] of Object.entries(release.urls)) {
    const bytes = await download(url);
    const checksum = (await download(`${url}.sha256`)).toString("utf8");
    integrity[name] = dashboardIntegrity(url, bytes, checksum);
  }
  return { ...release, integrity };
};

export const releaseNeedsUpdate = (release, versions) =>
  !versions.some((version) => compareVersions(release.version, version) < 0) &&
  !versions.every((version) => compareVersions(release.version, version) === 0);
