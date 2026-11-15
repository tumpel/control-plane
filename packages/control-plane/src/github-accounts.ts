import type { GitHubAccountSchema, GitHubAccountUnavailableReasonSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import {
  API_MEDIA_TYPE,
  callGitHub,
  exchangeUserCode,
  type Fetch,
  type GitHubAnswer,
  type GitHubInstallationRecord,
  type GitHubUser,
  installedBy,
  type OAuthClient,
  personDetail,
  type RecordedInstaller,
  tokenUser,
} from "./github.ts";
import {
  GitHubOrganizationMembershipsSchema,
  GitHubReachableInstallationSchema,
  GitHubReachableInstallationsSchema,
  type StoredGitHubAccountSchema,
} from "./github-schemas.ts";
import type { GitHubInstallation } from "./github-store.ts";

export type GitHubAccount = z.infer<typeof GitHubAccountSchema>;
export type StoredGitHubAccount = z.infer<typeof StoredGitHubAccountSchema>;
export type UnavailableReason = z.infer<typeof GitHubAccountUnavailableReasonSchema>;
export type ReachableInstallation = z.infer<typeof GitHubReachableInstallationSchema>;
export type OrganizationMembership = { gitHubAccountId: number; login: string; admin: boolean };

export interface GitHubReading {
  user: GitHubUser;
  installations: ReachableInstallation[];
  organizations: OrganizationMembership[];
}

const PAGE = "per_page=100";

export const readAccounts = async (
  fetcher: Fetch,
  origins: { api: string; web: string },
  client: OAuthClient,
  code: string,
): Promise<GitHubAnswer<GitHubReading>> => {
  const { api, web } = origins;
  const token = await exchangeUserCode(fetcher, web, client, code);
  if (!token.ok) return token;
  const bearer = token.value;
  const user = await tokenUser(fetcher, api, bearer);
  if (!user.ok) return { ...user, detail: personDetail(user, "who you are") };
  const installations = await callGitHub(
    fetcher,
    { method: "GET", url: `${api}/user/installations?${PAGE}`, accept: API_MEDIA_TYPE, bearer, body: null },
    GitHubReachableInstallationsSchema,
    "GitHubUserInstallations",
  );
  if (!installations.ok)
    return { ...installations, detail: personDetail(installations, "the installations you can access") };
  const memberships = await callGitHub(
    fetcher,
    {
      method: "GET",
      url: `${api}/user/memberships/orgs?state=active&${PAGE}`,
      accept: API_MEDIA_TYPE,
      bearer,
      body: null,
    },
    GitHubOrganizationMembershipsSchema,
    "GitHubOrganizationMemberships",
  );
  if (!memberships.ok) return { ...memberships, detail: personDetail(memberships, "your organizations") };
  return {
    ok: true,
    value: {
      user: user.value,
      installations: installations.value.installations.flatMap((candidate) => {
        const parsed = GitHubReachableInstallationSchema.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
      }),
      organizations: memberships.value.map(({ role, organization }) => ({
        gitHubAccountId: organization.id,
        login: organization.login,
        admin: role === "admin",
      })),
    },
  };
};

export type LinkDecision =
  | { kind: "Held" }
  | { kind: "Link"; installation: GitHubInstallationRecord }
  | { kind: "Unavailable"; reason: UnavailableReason; detail: string };

export const linkDecision = (
  tenantId: string,
  holder: string | null,
  user: GitHubUser,
  installation: GitHubInstallationRecord,
  recorded: RecordedInstaller,
): LinkDecision => {
  if (holder === tenantId) return { kind: "Held" };
  if (holder !== null) {
    return {
      kind: "Unavailable",
      reason: "OtherTenant",
      detail: `another Tumpel tenant holds installation ${installation.id} on ${installation.account.login}; disconnect it there, then refresh`,
    };
  }
  const binding = installedBy(user, installation, recorded);
  if (binding.kind === "Installer") return { kind: "Link", installation: binding.installation };
  return { kind: "Unavailable", reason: binding.kind, detail: binding.detail };
};

export const accountRows = (
  reading: GitHubReading,
  decisions: ReadonlyMap<number, LinkDecision>,
  requested: ReadonlySet<number>,
): StoredGitHubAccount[] => {
  const { user, organizations, installations } = reading;
  const accounts = [
    { gitHubAccountId: user.githubUserId, login: user.login, kind: "Personal" as const, role: "Owner" as const },
    ...organizations.map((organization) => ({
      gitHubAccountId: organization.gitHubAccountId,
      login: organization.login,
      kind: "Organization" as const,
      role: organization.admin ? ("Owner" as const) : ("Member" as const),
    })),
  ];
  return accounts.map((account) => {
    const installation = installations.find((candidate) => candidate.account.id === account.gitHubAccountId);
    const decision = installation === undefined ? undefined : decisions.get(installation.id);
    if (installation !== undefined && decision?.kind === "Unavailable") {
      return { ...account, standing: "Unavailable", installationId: installation.id, reason: decision.reason };
    }
    if (installation === undefined && requested.has(account.gitHubAccountId))
      return { ...account, standing: "Requested" };
    return { ...account, standing: "Open" };
  });
};

export const accountList = (stored: StoredGitHubAccount[], installations: GitHubInstallation[]): GitHubAccount[] =>
  stored.map((row) => {
    const account = { gitHubAccountId: row.gitHubAccountId, login: row.login, kind: row.kind, role: row.role };
    const held = installations.find(
      (installation) => installation.accountLogin.toLowerCase() === row.login.toLowerCase(),
    );
    if (held !== undefined) {
      return {
        ...account,
        state: "Installed",
        installationId: held.installationId,
        status: held.status,
        linkedAt: new Date(held.createdAt).toISOString(),
      };
    }
    if (row.standing === "Unavailable") {
      return { ...account, state: "Unavailable", installationId: row.installationId, reason: row.reason };
    }
    if (row.standing === "Requested") return { ...account, state: "Requested" };
    return { ...account, state: row.role === "Owner" ? "Install" : "Request" };
  });
