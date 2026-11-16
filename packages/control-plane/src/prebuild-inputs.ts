import type { PrebuildConfigSourceSchema } from "@tumpel/schemas";
import { z } from "zod";
import { callGitHub, type Fetch, type GitHubRepository } from "./github.ts";
import { GitHubCommitSchema } from "./github-schemas.ts";

export const DEVCONTAINER_DIRECTORY = ".devcontainer";
export const DEVCONTAINER_FILE = ".devcontainer.json";
export const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "pubspec.lock",
  "flake.lock",
];
export const MANIFESTS = ["package.json"];
const DEVCONTAINER_CONFIGS = [`${DEVCONTAINER_DIRECTORY}/devcontainer.json`, DEVCONTAINER_FILE];

export type ConfigSource = z.infer<typeof PrebuildConfigSourceSchema>;

const API_MEDIA_TYPE = "application/vnd.github+json";

export interface InputFile {
  path: string;
  blobSha: string;
}

export type Inputs =
  | {
      kind: "Read";
      files: InputFile[];
      configSource: ConfigSource;
      headSha: string;
    }
  | { kind: "Unreadable"; detail: string };

export type DefaultBranch = { kind: "Branch"; branch: string } | { kind: "Unreadable"; detail: string };

const countsAtRoot = (path: string): boolean =>
  path === DEVCONTAINER_FILE || LOCKFILES.includes(path) || MANIFESTS.includes(path);

const encoder = new TextEncoder();

const hex = (digest: ArrayBuffer): string =>
  [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const byteOrder = (a: InputFile, b: InputFile): number => {
  const left = encoder.encode(a.path);
  const right = encoder.encode(b.path);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
};

export const inputDigest = async (files: readonly InputFile[]): Promise<string> => {
  const lines = [...files].sort(byteOrder).map((file) => `${file.path}\0${file.blobSha}\n`);
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(lines.join(""))));
};

const RepositorySchema = z.object({ default_branch: z.string().min(1) });
const TreeSchema = z.object({
  tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })),
});

const read = <T>(fetcher: Fetch, url: string, token: string, schema: z.ZodType<T>, name: string) =>
  callGitHub(fetcher, { method: "GET", url, accept: API_MEDIA_TYPE, bearer: token, body: null }, schema, name);

const unreadable = (target: GitHubRepository, detail: string): { kind: "Unreadable"; detail: string } => ({
  kind: "Unreadable",
  detail: `${detail}; check that the token reads ${target.owner}/${target.name}`,
});

const repositoryBase = (api: string, target: GitHubRepository): string =>
  `${api}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`;

export const readDefaultBranch = async (
  fetcher: Fetch,
  api: string,
  target: GitHubRepository,
  token: string,
): Promise<DefaultBranch> => {
  const described = await read(fetcher, repositoryBase(api, target), token, RepositorySchema, "repository");
  if (!described.ok) return unreadable(target, described.detail);
  return { kind: "Branch", branch: described.value.default_branch };
};

export const readInputs = async (
  fetcher: Fetch,
  api: string,
  target: GitHubRepository,
  token: string,
  ref: string,
): Promise<Inputs> => {
  const base = repositoryBase(api, target);
  const head = await read(fetcher, `${base}/commits/${encodeURIComponent(ref)}`, token, GitHubCommitSchema, "commit");
  if (!head.ok) return unreadable(target, head.detail);
  const headSha = head.value.sha;
  const root = await read(fetcher, `${base}/git/trees/${head.value.commit.tree.sha}`, token, TreeSchema, "git tree");
  if (!root.ok) return unreadable(target, root.detail);
  const files: InputFile[] = root.value.tree
    .filter((entry) => entry.type === "blob" && countsAtRoot(entry.path))
    .map((entry) => ({ path: entry.path, blobSha: entry.sha }));
  const devcontainer = root.value.tree.find((entry) => entry.type === "tree" && entry.path === DEVCONTAINER_DIRECTORY);
  if (devcontainer !== undefined) {
    const subtree = await read(
      fetcher,
      `${base}/git/trees/${devcontainer.sha}?recursive=1`,
      token,
      TreeSchema,
      "git tree",
    );
    if (!subtree.ok) return unreadable(target, subtree.detail);
    for (const entry of subtree.value.tree) {
      if (entry.type === "blob") files.push({ path: `${DEVCONTAINER_DIRECTORY}/${entry.path}`, blobSha: entry.sha });
    }
  }
  const configSource = files.some((file) => DEVCONTAINER_CONFIGS.includes(file.path)) ? "RepositoryFile" : "Default";
  return { kind: "Read", files, configSource, headSha };
};
