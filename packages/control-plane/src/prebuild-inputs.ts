import { z } from "zod";
import { callGitHub, type Fetch, GITHUB_API, type GitHubRepository } from "./github.ts";

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

const API_MEDIA_TYPE = "application/vnd.github+json";

export interface InputFile {
  path: string;
  blobSha: string;
}

export type Inputs =
  | { kind: "Read"; files: InputFile[]; defaultBranch: string }
  | { kind: "Empty"; detail: string }
  | { kind: "Unreadable"; detail: string };

const countsAtRoot = (path: string): boolean => path === DEVCONTAINER_FILE || LOCKFILES.includes(path);

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

export const readInputs = async (fetcher: Fetch, target: GitHubRepository, token: string): Promise<Inputs> => {
  const repository = `${target.owner}/${target.name}`;
  const base = `${GITHUB_API}/repos/${repository}`;
  const unreadable = (detail: string): Inputs => ({
    kind: "Unreadable",
    detail: `${detail}; check that the token reads ${repository}`,
  });
  const described = await read(fetcher, base, token, RepositorySchema, "repository");
  if (!described.ok) return unreadable(described.detail);
  const branch = described.value.default_branch;
  const root = await read(fetcher, `${base}/git/trees/${encodeURIComponent(branch)}`, token, TreeSchema, "git tree");
  if (!root.ok) return unreadable(root.detail);
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
    if (!subtree.ok) return unreadable(subtree.detail);
    for (const entry of subtree.value.tree) {
      if (entry.type === "blob") files.push({ path: `${DEVCONTAINER_DIRECTORY}/${entry.path}`, blobSha: entry.sha });
    }
  }
  if (files.length === 0) {
    return {
      kind: "Empty",
      detail: `${repository} holds no file under .devcontainer/, no .devcontainer.json and none of ${LOCKFILES.join(", ")} at its root on ${branch}, so a prebuild has nothing to install`,
    };
  }
  return { kind: "Read", files, defaultBranch: branch };
};
