import type { PrebuildTemplatePullRequestSchema } from "@tumpel/schemas";
import { z } from "zod";
import { callGitHub, type Fetch, type GitHubAnswer, type GitHubRepository, repositoryUrl } from "./github.ts";
import { DEVCONTAINER_CONFIGS, readDefaultBranch, readInputs } from "./prebuild-inputs.ts";
import type { PrebuildTemplateVersion } from "./template-catalog.ts";

export type PrebuildTemplatePullRequest = z.infer<typeof PrebuildTemplatePullRequestSchema>;

export const TEMPLATE_BRANCH = "tumpel/prebuild-template";
export const TEMPLATE_PATH = ".devcontainer/devcontainer.json";

const API_MEDIA_TYPE = "application/vnd.github+json";
const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const ShaSchema = z.object({ sha: SHA });
const RefSchema = z.object({ object: z.object({ sha: SHA }) });
const PullSchema = z.object({
  number: z.number().int().min(1),
  html_url: z.url(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
});
const PullsSchema = z.array(PullSchema);

type Pull = z.infer<typeof PullSchema>;

export type Opened =
  | { kind: "Opened"; pullRequest: PrebuildTemplatePullRequest }
  | { kind: "Exists"; path: string }
  | { kind: "Refused"; detail: string };

export type Read =
  | { kind: "Read"; pullRequest: PrebuildTemplatePullRequest }
  | { kind: "None" }
  | { kind: "Refused"; detail: string };

const repositoryPath = (api: string, target: GitHubRepository): string =>
  `${api}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`;

const call = <T>(
  fetcher: Fetch,
  token: string,
  method: "GET" | "POST" | "PATCH",
  url: string,
  body: unknown,
  schema: z.ZodType<T>,
  name: string,
): Promise<GitHubAnswer<T>> =>
  callGitHub(fetcher, { method, url, accept: API_MEDIA_TYPE, bearer: token, body }, schema, name);

const answerOf = (target: GitHubRepository, pull: Pull): PrebuildTemplatePullRequest => ({
  repository: repositoryUrl(target),
  branch: TEMPLATE_BRANCH,
  pullRequestNumber: pull.number,
  url: pull.html_url,
  state: pull.merged_at !== null ? "Merged" : pull.state === "open" ? "Open" : "Closed",
});

const pullsOf = (api: string, target: GitHubRepository, state: "open" | "all"): string =>
  `${repositoryPath(api, target)}/pulls?head=${encodeURIComponent(`${target.owner}:${TEMPLATE_BRANCH}`)}&state=${state}&sort=created&direction=desc&per_page=1`;

const describe = (template: PrebuildTemplateVersion, replaced: string[]) => {
  const name = `${template.prebuildTemplateId} prebuild template, version ${template.prebuildTemplateVersion}`;
  return {
    title: `chore: add the tumpel ${name}`,
    message: `chore: add the tumpel ${name}`,
    body: [
      `Adds the tumpel ${name} as ${TEMPLATE_PATH}. ${template.summary}`,
      ...(replaced.length > 0 ? [`It replaces the existing ${replaced.join(" and ")}.`] : []),
      "Edit the commands in this pull request if the repository needs more, then merge it and start a prebuild.",
    ].join("\n\n"),
  };
};

export const openTemplatePullRequest = async (
  fetcher: Fetch,
  api: string,
  token: string,
  target: GitHubRepository,
  request: { template: PrebuildTemplateVersion; replace: boolean },
): Promise<Opened> => {
  const described = await readDefaultBranch(fetcher, api, target, token);
  if (described.kind === "Unreadable") return { kind: "Refused", detail: described.detail };
  const inputs = await readInputs(fetcher, api, target, token, described.branch);
  if (inputs.kind === "Unreadable") return { kind: "Refused", detail: inputs.detail };
  const existing = DEVCONTAINER_CONFIGS.filter((path) => inputs.files.some((file) => file.path === path));
  const [held] = existing;
  if (held !== undefined && !request.replace) return { kind: "Exists", path: held };
  const base = repositoryPath(api, target);
  const text = describe(request.template, existing);
  const removed = existing.filter((path) => path !== TEMPLATE_PATH);
  const tree = await call(
    fetcher,
    token,
    "POST",
    `${base}/git/trees`,
    {
      base_tree: inputs.treeSha,
      tree: [
        { path: TEMPLATE_PATH, mode: "100644", type: "blob", content: request.template.devcontainer },
        ...removed.map((path) => ({ path, mode: "100644", type: "blob", sha: null })),
      ],
    },
    ShaSchema,
    "git tree",
  );
  if (!tree.ok) return { kind: "Refused", detail: tree.detail };
  const commit = await call(
    fetcher,
    token,
    "POST",
    `${base}/git/commits`,
    { message: text.message, tree: tree.value.sha, parents: [inputs.headSha] },
    ShaSchema,
    "git commit",
  );
  if (!commit.ok) return { kind: "Refused", detail: commit.detail };
  const ref = await call(fetcher, token, "GET", `${base}/git/ref/heads/${TEMPLATE_BRANCH}`, null, RefSchema, "git ref");
  if (!ref.ok && ref.status !== 404) return { kind: "Refused", detail: ref.detail };
  const moved = ref.ok
    ? await call(
        fetcher,
        token,
        "PATCH",
        `${base}/git/refs/heads/${TEMPLATE_BRANCH}`,
        { sha: commit.value.sha, force: true },
        RefSchema,
        "git ref",
      )
    : await call(
        fetcher,
        token,
        "POST",
        `${base}/git/refs`,
        { ref: `refs/heads/${TEMPLATE_BRANCH}`, sha: commit.value.sha },
        RefSchema,
        "git ref",
      );
  if (!moved.ok) return { kind: "Refused", detail: moved.detail };
  const open = await call(fetcher, token, "GET", pullsOf(api, target, "open"), null, PullsSchema, "pull request list");
  if (!open.ok) return { kind: "Refused", detail: open.detail };
  const [current] = open.value;
  const pull =
    current === undefined
      ? await call(
          fetcher,
          token,
          "POST",
          `${base}/pulls`,
          { title: text.title, body: text.body, head: TEMPLATE_BRANCH, base: described.branch },
          PullSchema,
          "pull request",
        )
      : await call(
          fetcher,
          token,
          "PATCH",
          `${base}/pulls/${current.number}`,
          { title: text.title, body: text.body },
          PullSchema,
          "pull request",
        );
  if (!pull.ok) return { kind: "Refused", detail: pull.detail };
  return { kind: "Opened", pullRequest: answerOf(target, pull.value) };
};

export const readTemplatePullRequest = async (
  fetcher: Fetch,
  api: string,
  token: string,
  target: GitHubRepository,
): Promise<Read> => {
  const pulls = await call(fetcher, token, "GET", pullsOf(api, target, "all"), null, PullsSchema, "pull request list");
  if (!pulls.ok) return { kind: "Refused", detail: pulls.detail };
  const [newest] = pulls.value;
  if (newest === undefined) return { kind: "None" };
  return { kind: "Read", pullRequest: answerOf(target, newest) };
};
