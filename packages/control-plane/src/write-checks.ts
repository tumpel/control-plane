import { checkCredential } from "@tumpel/api/credentials";
import type { HarnessPinCreateSchema, SecretSetSchema, SecretValueSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { type GitHubUser, REPOSITORY_TOKEN, tokenUser } from "./github.ts";
import { inCatalog, pinnedEntry } from "./harness-catalog.ts";
import { listHosts } from "./hosts.ts";
import { problem } from "./http.ts";
import type { Env } from "./index.ts";
import { checkFiles, type PersonaFileWrite, type StoredFile, storeFiles } from "./persona-files.ts";
import { bootArchitectures, readRelease, releaseUnreadable } from "./releases.ts";
import { credentialRefused } from "./sessions.ts";
import type { HarnessPinWrite } from "./tenant.ts";

type HarnessPinCreate = z.infer<typeof HarnessPinCreateSchema>;
type Member = z.infer<typeof SecretSetSchema>["keys"][number] | z.infer<typeof SecretValueSchema>;

export interface PersonaCheck {
  harness: string;
  files: PersonaFileWrite[];
  secretSetName: string;
  members: Member[];
  pins: HarnessPinCreate[];
  newSecretSet: boolean;
}

export const personaFiles = async (
  env: Env,
  tenantId: string,
  check: PersonaCheck,
  operation: string,
): Promise<{ ok: true; value: StoredFile[] } | { ok: false; response: Response }> => {
  const entry = pinnedEntry(check.pins, check.harness);
  if (entry === undefined) {
    return {
      ok: false,
      response: problem(422, {
        code: "HarnessNotInCatalog",
        title: "Harness not in the catalog",
        detail: `${operation} names ${check.harness}, of which the catalog holds no version your tenant can run`,
        fix: "Name a harness the harness catalog lists, or pin one of its listed versions",
      }),
    };
  }
  const credential = checkCredential(entry, check.members, Date.now());
  if (credential.kind === "Unsupported" || (credential.kind === "NoCredential" && check.newSecretSet)) {
    const refused = credentialRefused(
      credential,
      `secret set ${check.secretSetName}`,
      check.harness,
      `repeat ${operation}`,
    );
    return { ok: false, response: problem(refused.status, refused.problem) };
  }
  const checked = await checkFiles(entry, check.files, operation);
  if (!checked.ok) return { ok: false, response: problem(422, checked.problem) };
  const stored = await storeFiles(env.STORE, tenantId, checked.files, operation);
  if (!stored.ok) return { ok: false, response: problem(422, stored.problem) };
  return { ok: true, value: stored.files };
};

type TokenUserRead = { ok: true; user: GitHubUser | null } | { ok: false; response: Response };

export const repositoryTokenUser = async (
  env: Env,
  secrets: readonly { kind: string; name: string; value?: string }[],
  operation: string,
): Promise<TokenUserRead> => {
  const token = secrets.find((member) => member.kind === "Variable" && member.name === REPOSITORY_TOKEN);
  if (token?.value === undefined) return { ok: true, user: null };
  const read = await tokenUser((url, init) => fetch(url, init), env.GITHUB_API_ORIGIN, token.value);
  if (read.ok) return { ok: true, user: read.value };
  return {
    ok: false,
    response: problem(400, {
      code: "InvalidRequest",
      title: "GitHub token refused",
      detail: `${operation} refused the value of member ${REPOSITORY_TOKEN}: ${read.detail}`,
      fix: `Write a ${REPOSITORY_TOKEN} that GitHub accepts; the box commits as its GitHub user`,
    }),
  };
};

const unreleasedPin = async (
  env: Env,
  tenantId: string,
  harness: string,
  harnessVersion: string,
): Promise<Response | null> => {
  const architectures = [...new Set((await listHosts(env.DB, tenantId)).map((host) => host.architecture))];
  if (architectures.length === 0) return null;
  const release = await readRelease(env.RELEASES, Date.now());
  if (release.kind === "Unpublished") return noRelease();
  if (release.kind === "Unreadable") return problem(422, releaseUnreadable(release.detail, "pin the version again"));
  const carried = bootArchitectures(release, harness, harnessVersion);
  if (architectures.some((architecture) => carried.includes(architecture))) return null;
  return problem(422, {
    code: "ImageNotReleased",
    title: "Harness version not in the current release",
    detail: `release ${release.manifest.releaseVersion} carries no ${harness} ${harnessVersion} guest image for ${architectures.join(" or ")}, the architectures of your tenant's hosts`,
    fix: "Pin a version the current release carries for one of those architectures, or ask the operator, who publishes releases, for one that carries it",
  });
};

export const pinRefusal = async (env: Env, tenantId: string, pin: HarnessPinWrite): Promise<Response | null> => {
  if (!inCatalog(pin.harness, pin.harnessVersion)) {
    return problem(422, {
      code: "HarnessNotInCatalog",
      title: "Harness version not in the catalog",
      detail: `the catalog has no ${pin.harness} ${pin.harnessVersion}`,
      fix: "Pin a version the harness catalog lists",
    });
  }
  return unreleasedPin(env, tenantId, pin.harness, pin.harnessVersion);
};

export const noRelease = (): Response =>
  problem(404, {
    code: "NoRelease",
    title: "No release published",
    detail: "the release bucket of this stage holds no current.json",
    fix: "Publish a release with the release workflow, then try again",
  });
