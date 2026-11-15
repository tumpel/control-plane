import assert from "node:assert/strict";
import { test } from "node:test";
import { linkDecision } from "../src/github-accounts.ts";

const TENANT = "tnt_mine";
const user = { githubUserId: 5, login: "owner" };
const organization = { id: 9, account: { login: "acme", type: "Organization" as const } };
const installedByOwner = { kind: "Recorded" as const, githubUserId: 5 };

test("a return links an installation only when no tenant holds it and the person signed in to GitHub installed it", () => {
  assert.deepEqual(linkDecision(TENANT, TENANT, user, organization, installedByOwner), { kind: "Held" });
  assert.deepEqual(linkDecision(TENANT, null, user, organization, installedByOwner), {
    kind: "Link",
    installation: organization,
  });

  const unknown = linkDecision(TENANT, null, user, organization, { kind: "Unrecorded" });
  assert.equal(unknown.kind === "Unavailable" && unknown.reason, "InstallerUnknown");

  const someoneElse = linkDecision(TENANT, null, user, organization, { kind: "Recorded", githubUserId: 6 });
  assert.equal(someoneElse.kind === "Unavailable" && someoneElse.reason, "NotInstaller");

  const otherTenant = linkDecision(TENANT, "tnt_theirs", user, organization, installedByOwner);
  assert.equal(otherTenant.kind === "Unavailable" && otherTenant.reason, "OtherTenant");
});
