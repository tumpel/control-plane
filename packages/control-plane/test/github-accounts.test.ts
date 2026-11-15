import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTALL_REQUEST_TTL_MS } from "../src/github.ts";
import { type AccountFacts, accountList, type GitHubAccount } from "../src/github-accounts.ts";

const TENANT = "tnt_mine";
const NOW = Date.parse("2026-11-15T12:00:00Z");

const organization = (gitHubAccountId: number, login: string, role: "Owner" | "Member") => ({
  gitHubAccountId,
  login,
  role,
});
const reachable = (id: number, accountId: number, login: string) => ({
  id,
  account: { id: accountId, login, type: "Organization" as const },
});
const held = (installationId: number, accountLogin: string) => ({
  installationId,
  tenantId: TENANT,
  accountLogin,
  status: "Active" as const,
  createdAt: NOW,
  updatedAt: NOW,
});

const facts: AccountFacts = {
  tenantId: TENANT,
  reading: {
    user: { githubUserId: 5, login: "owner" },
    organizations: [
      organization(10, "linked", "Owner"),
      organization(11, "fresh", "Owner"),
      organization(12, "member", "Member"),
      organization(13, "asked", "Member"),
      organization(14, "stale", "Member"),
      organization(15, "theirs", "Owner"),
      organization(16, "unnamed", "Owner"),
    ],
    installations: [reachable(100, 10, "linked"), reachable(105, 15, "theirs"), reachable(106, 16, "unnamed")],
  },
  requests: [
    { gitHubAccountId: 13, requestedAt: NOW - 3_600_000 },
    { gitHubAccountId: 14, requestedAt: NOW - INSTALL_REQUEST_TTL_MS },
  ],
  installations: [held(100, "linked"), held(200, "elsewhere")],
  holders: new Map([
    [100, TENANT],
    [105, "tnt_theirs"],
  ]),
  installers: new Map(),
  now: NOW,
};

const rows = (accounts: GitHubAccount[]): string[] =>
  accounts.map((account) => {
    if (account.state === "Installed") return `Installed ${account.installationId}`;
    if (account.state === "Unavailable") return `Unavailable ${account.login} ${account.reason}`;
    return `${account.state} ${account.login}`;
  });

test("the account list derives every row from the stored GitHub reading and the installations now", () => {
  assert.deepEqual(rows(accountList(facts)), [
    "Installed 100",
    "Installed 200",
    "Install owner",
    "Install fresh",
    "Request member",
    "Requested asked",
    "Request stale",
    "Unavailable theirs OtherTenant",
    "Unavailable unnamed InstallerUnknown",
  ]);

  const released = accountList({ ...facts, holders: new Map([[100, TENANT]]), installers: new Map([[105, 5]]) });
  assert.deepEqual(rows(released).slice(-2), ["Install theirs", "Unavailable unnamed InstallerUnknown"]);
});
