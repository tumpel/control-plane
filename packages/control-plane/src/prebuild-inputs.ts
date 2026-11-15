import { z } from "zod";
import { callGitHub, type Fetch, GITHUB_API, githubRepository } from "./github.ts";

export const DEVCONTAINER_DIRECTORY = ".devcontainer/";
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
  bytes: Uint8Array;
}

export type Inputs =
  | { kind: "Read"; files: InputFile[] }
  | { kind: "Empty"; detail: string }
  | { kind: "Unreadable"; detail: string };

export const countsAsInput = (path: string): boolean =>
  path.startsWith(DEVCONTAINER_DIRECTORY) || path === DEVCONTAINER_FILE || LOCKFILES.includes(path);

const encoder = new TextEncoder();

const hex = (digest: ArrayBuffer): string =>
  [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));

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
  const lines: string[] = [];
  for (const file of [...files].sort(byteOrder)) lines.push(`${file.path}\0${await sha256(file.bytes)}\n`);
  return sha256(encoder.encode(lines.join("")));
};

const RepositorySchema = z.object({ default_branch: z.string().min(1) });
const TreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })),
});
const BlobSchema = z.object({ encoding: z.literal("base64"), content: z.string() });

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replace(/\s+/g, "")), (char) => char.charCodeAt(0));

const read = <T>(fetcher: Fetch, url: string, token: string | null, schema: z.ZodType<T>, name: string) =>
  callGitHub(fetcher, { method: "GET", url, accept: API_MEDIA_TYPE, bearer: token, body: null }, schema, name);

export const readInputs = async (fetcher: Fetch, repository: string, token: string | null): Promise<Inputs> => {
  const target = githubRepository(repository);
  if (target === null) {
    return {
      kind: "Unreadable",
      detail: `${repository} is not a GitHub repository URL like https://github.com/acme/app`,
    };
  }
  const base = `${GITHUB_API}/repos/${target.owner}/${target.name}`;
  const unreadable = (detail: string): Inputs => ({
    kind: "Unreadable",
    detail: `${detail}; ${token === null ? `install the GitHub App on ${target.owner} with tumpel github start, or add a GITHUB_TOKEN that reads ${target.owner}/${target.name} to the persona's secret set` : `check that the token reads ${target.owner}/${target.name}`}`,
  });
  const described = await read(fetcher, base, token, RepositorySchema, "repository");
  if (!described.ok) return unreadable(described.detail);
  const branch = described.value.default_branch;
  const listed = await read(
    fetcher,
    `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token,
    TreeSchema,
    "git tree",
  );
  if (!listed.ok) return unreadable(listed.detail);
  if (listed.value.truncated) {
    return {
      kind: "Unreadable",
      detail: `GitHub truncated the tree of ${target.owner}/${target.name} at ${branch}, so the devcontainer files and lockfiles cannot all be found; a repository this large cannot be prebuilt yet`,
    };
  }
  const blobs = listed.value.tree.filter((entry) => entry.type === "blob" && countsAsInput(entry.path));
  if (blobs.length === 0) {
    return {
      kind: "Empty",
      detail: `${target.owner}/${target.name} holds no .devcontainer/ directory, no .devcontainer.json and none of ${LOCKFILES.join(", ")} at its root on ${branch}, so a prebuild has nothing to install`,
    };
  }
  const files: InputFile[] = [];
  for (const blob of blobs) {
    const fetched = await read(fetcher, `${base}/git/blobs/${blob.sha}`, token, BlobSchema, "blob");
    if (!fetched.ok) return unreadable(fetched.detail);
    files.push({ path: blob.path, bytes: fromBase64(fetched.value.content) });
  }
  return { kind: "Read", files };
};
