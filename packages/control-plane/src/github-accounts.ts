import type { GitHubAccountInstalledSchema, GitHubAccountSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import {
  API_MEDIA_TYPE,
  callGitHub,
  exchangeUserCode,
  type Fetch,
  type GitHubAnswer,
  INSTALL_REQUEST_TTL_MS,
  installedBy,
  type OAuthClient,
  personDetail,
  tokenUser,
} from "./github.ts";
import {
  GitHubOrganizationMembershipsSchema,
  GitHubReachableInstallationsSchema,
  type GitHubReadingSchema,
} from "./github-schemas.ts";
import type { GitHubInstallation } from "./github-store.ts";

export type GitHubAccount = z.infer<typeof GitHubAccountSchema>;
export type InstalledAccount = z.infer<typeof GitHubAccountInstalledSchema>;
export type GitHubReading = z.infer<typeof GitHubReadingSchema>;
export type InstallRequest = { gitHubAccountId: number; requestedAt: number };

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
      installations: installations.value.installations,
      organizations: memberships.value.map(({ role, organization }) => ({
        gitHubAccountId: organization.id,
        login: organization.login,
        role: role === "admin" ? "Owner" : "Member",
      })),
    },
  };
};

export interface AccountFacts {
  tenantId: string;
  reading: GitHubReading;
  requests: InstallRequest[];
  installations: GitHubInstallation[];
  holders: ReadonlyMap<number, string>;
  installers: ReadonlyMap<number, number>;
  now: number;
}

export const installedRows = (installations: GitHubInstallation[]): InstalledAccount[] =>
  installations.map((installation) => ({
    state: "Installed",
    installationId: installation.installationId,
    login: installation.accountLogin,
    status: installation.status,
    linkedAt: new Date(installation.createdAt).toISOString(),
  }));

export const accountList = (facts: AccountFacts): GitHubAccount[] => {
  const { tenantId, reading, requests, installations, holders, installers, now } = facts;
  const { user } = reading;
  const accounts = [
    { gitHubAccountId: user.githubUserId, login: user.login, kind: "Personal" as const, role: "Owner" as const },
    ...reading.organizations.map((organization) => ({ ...organization, kind: "Organization" as const })),
  ];
  const held = new Set(installations.map((installation) => installation.installationId));
  const open = (account: (typeof accounts)[number]): GitHubAccount => ({
    ...account,
    state: account.role === "Owner" ? "Install" : "Request",
  });
  const rows = accounts.flatMap((account): GitHubAccount[] => {
    const installation = reading.installations.find((candidate) => candidate.account.id === account.gitHubAccountId);
    if (installation === undefined) {
      const request = requests.find((candidate) => candidate.gitHubAccountId === account.gitHubAccountId);
      const pending = request !== undefined && now - request.requestedAt < INSTALL_REQUEST_TTL_MS;
      return [pending ? { ...account, state: "Requested" } : open(account)];
    }
    if (held.has(installation.id)) return [];
    const holder = holders.get(installation.id);
    if (holder !== undefined && holder !== tenantId) {
      return [{ ...account, state: "Unavailable", installationId: installation.id, reason: "OtherTenant" }];
    }
    const installer = installers.get(installation.id);
    const binding = installedBy(
      user,
      installation,
      installer === undefined ? { kind: "Unrecorded" } : { kind: "Recorded", githubUserId: installer },
    );
    if (binding.kind === "Installer") return [open(account)];
    return [{ ...account, state: "Unavailable", installationId: installation.id, reason: binding.kind }];
  });
  return [...installedRows(installations), ...rows];
};
