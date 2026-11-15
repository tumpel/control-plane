import {
  CircleCIAuthorizationSchema,
  CircleCIAuthorizationStateSchema,
  CircleCIOrganizationSchema,
} from "@tumpel/api/schemas";
import { z } from "zod";
import { readCollaborations } from "./circleci.ts";
import {
  advanceAuthorization,
  authorizeUrl,
  CHOOSE_BUDGET_SECONDS,
  CIRCLECI_REDIRECT_URI,
  type CircleCIAuthorization,
  type CircleCIAuthorizationFailureReason,
  type CircleCIAuthorizationState,
  type CircleCIOrganization,
  deniedDetail,
  exchangeCode,
  organizationsOf,
  parseRedirect,
  REDIRECT_BUDGET_SECONDS,
  registerClient,
  stateMismatchDetail,
} from "./circleci-oauth.ts";
import { base64Url, randomToken, sameSecret } from "./crypto";
import { seal, unseal } from "./envelope.ts";
import type { Fetch } from "./github.ts";
import type { CircleCIAuthorizationDeadline } from "./session-timer";
import { TenantClaudeSetups } from "./tenant-claude-setups";

type CircleCIAuthorizationRow = {
  circleci_authorization_id: string;
  principal_id: string;
  client_id: string;
  redirect_uri: string;
  authorize_url: string;
  oauth_state: string;
  phase: string;
  phase_due_at: number;
  token_expires_at: number | null;
  organizations: string | null;
  organization_id: string | null;
  account_label: string | null;
  reason: string | null;
  detail: string | null;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
};

export type CircleCIAuthorizationStarted =
  | { kind: "Started"; authorization: CircleCIAuthorization }
  | { kind: "RegistrationRefused"; detail: string };

export type CircleCIAuthorizationStepped =
  | { kind: "Stepped"; authorization: CircleCIAuthorization }
  | { kind: "NotFound" }
  | { kind: "NotWaiting"; detail: string }
  | { kind: "Invalid"; detail: string };

const SELECT = `SELECT circleci_authorization_id, principal_id, client_id, redirect_uri, authorize_url, oauth_state, phase,
  phase_due_at, token_expires_at, organizations, organization_id, account_label, reason, detail, ended_at, created_at,
  updated_at FROM circleci_authorizations`;

const LIVE_PHASES = "('AwaitingRedirect', 'ChoosingOrganization')";

const OrganizationsSchema = z.array(CircleCIOrganizationSchema);

const verifierContext = (circleCIAuthorizationId: string): string =>
  `circleci-authorization/${circleCIAuthorizationId}/verifier`;
const tokenContext = (circleCIAuthorizationId: string): string =>
  `circleci-authorization/${circleCIAuthorizationId}/token`;

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

const required = <T>(value: T | null, column: string, row: CircleCIAuthorizationRow): T => {
  if (value === null) {
    throw new Error(`CircleCI authorization ${row.circleci_authorization_id} is ${row.phase} and has no ${column}`);
  }
  return value;
};

const statusOf = (row: CircleCIAuthorizationRow): unknown => {
  if (row.phase === "AwaitingRedirect") {
    return {
      state: "AwaitingRedirect",
      authorizeUrl: row.authorize_url,
      redirectUri: row.redirect_uri,
      redirectDueAt: iso(row.phase_due_at),
    };
  }
  if (row.phase === "ChoosingOrganization") {
    return {
      state: "ChoosingOrganization",
      organizations: OrganizationsSchema.parse(JSON.parse(required(row.organizations, "organizations", row))),
      chooseDueAt: iso(row.phase_due_at),
    };
  }
  if (row.phase === "Completed") {
    return {
      state: "Completed",
      organizationId: required(row.organization_id, "organization_id", row),
      accountLabel: required(row.account_label, "account_label", row),
      expiresAt: iso(required(row.token_expires_at, "token_expires_at", row)),
      completedAt: iso(required(row.ended_at, "ended_at", row)),
    };
  }
  return {
    state: "Failed",
    reason: required(row.reason, "reason", row),
    detail: required(row.detail, "detail", row),
    failedAt: iso(required(row.ended_at, "ended_at", row)),
  };
};

const toAuthorization = (tenantId: string, row: CircleCIAuthorizationRow): CircleCIAuthorization =>
  CircleCIAuthorizationSchema.parse({
    circleCIAuthorizationId: row.circleci_authorization_id,
    tenantId,
    principalId: row.principal_id,
    status: statusOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const phaseOf = (row: CircleCIAuthorizationRow): CircleCIAuthorizationState =>
  CircleCIAuthorizationStateSchema.parse(row.phase);

const fetcher: Fetch = (url, init) => fetch(url, init);

const pkcePair = async (): Promise<{ verifier: string; challenge: string }> => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64Url(digest) };
};

export class TenantCircleCIAuthorizations extends TenantClaudeSetups {
  private readonly exchanging = new Set<string>();

  private circleCIAuthorizationRow(circleCIAuthorizationId: string): CircleCIAuthorizationRow | null {
    const [row] = this.ctx.storage.sql
      .exec<CircleCIAuthorizationRow>(`${SELECT} WHERE circleci_authorization_id = ?`, circleCIAuthorizationId)
      .toArray();
    return row ?? null;
  }

  private presentCircleCIAuthorization(tenantId: string, circleCIAuthorizationId: string): CircleCIAuthorization {
    const row = this.circleCIAuthorizationRow(circleCIAuthorizationId);
    if (row === null)
      throw new Error(`CircleCI authorization ${circleCIAuthorizationId} vanished while it was read back`);
    return toAuthorization(tenantId, row);
  }

  private circleCIAuthorizationTimer(tenantId: string, circleCIAuthorizationId: string, at: number | null) {
    return this.env.SESSION_TIMER.getByName(circleCIAuthorizationId).set(tenantId, {
      CircleCIAuthorization: at === null ? null : { circleCIAuthorizationId, at },
    });
  }

  private async failCircleCIAuthorization(
    tenantId: string,
    circleCIAuthorizationId: string,
    reason: CircleCIAuthorizationFailureReason,
    detail: string,
    now: number,
  ): Promise<void> {
    const moved = this.ctx.storage.sql.exec(
      `UPDATE circleci_authorizations SET phase = 'Failed', reason = ?, detail = ?, verifier_sealed = NULL, token_sealed = NULL,
      ended_at = ?, updated_at = ? WHERE circleci_authorization_id = ? AND phase IN ${LIVE_PHASES}`,
      reason,
      detail,
      now,
      now,
      circleCIAuthorizationId,
    ).rowsWritten;
    if (moved > 0) await this.circleCIAuthorizationTimer(tenantId, circleCIAuthorizationId, null);
  }

  private async ownCircleCIAuthorization(
    tenantId: string,
    principalId: string,
    circleCIAuthorizationId: string,
    now: number,
  ): Promise<CircleCIAuthorizationRow | null> {
    const row = this.circleCIAuthorizationRow(circleCIAuthorizationId);
    if (row === null || row.principal_id !== principalId) return null;
    if (row.phase_due_at > now) return row;
    const step = advanceAuthorization(circleCIAuthorizationId, phaseOf(row), { kind: "Deadline" });
    if (step.kind !== "Fail") return row;
    await this.failCircleCIAuthorization(tenantId, circleCIAuthorizationId, step.reason, step.detail, now);
    return this.circleCIAuthorizationRow(circleCIAuthorizationId);
  }

  private async circleCIClientId(): Promise<
    { kind: "Registered"; clientId: string } | { kind: "Refused"; detail: string }
  > {
    const [held] = this.ctx.storage.sql
      .exec<{ client_id: string }>(
        "SELECT client_id FROM circleci_clients WHERE client_slot = 1 AND redirect_uri = ?",
        CIRCLECI_REDIRECT_URI,
      )
      .toArray();
    if (held !== undefined) return { kind: "Registered", clientId: held.client_id };
    const registered = await registerClient(fetcher, this.env.CIRCLECI_APP_ORIGIN, CIRCLECI_REDIRECT_URI);
    if (registered.kind === "Refused") return registered;
    this.ctx.storage.sql.exec(
      `INSERT INTO circleci_clients (client_slot, client_id, redirect_uri, created_at) VALUES (1, ?, ?, ?)
      ON CONFLICT (client_slot) DO UPDATE SET client_id = excluded.client_id, redirect_uri = excluded.redirect_uri,
      created_at = excluded.created_at`,
      registered.clientId,
      CIRCLECI_REDIRECT_URI,
      Date.now(),
    );
    return registered;
  }

  async startCircleCIAuthorization(
    tenantId: string,
    principalId: string,
    now: number,
  ): Promise<CircleCIAuthorizationStarted> {
    const client = await this.circleCIClientId();
    if (client.kind === "Refused") return { kind: "RegistrationRefused", detail: client.detail };
    const circleCIAuthorizationId = crypto.randomUUID();
    const { verifier, challenge } = await pkcePair();
    const oauthState = randomToken();
    const url = authorizeUrl(this.env.CIRCLECI_APP_ORIGIN, {
      clientId: client.clientId,
      redirectUri: CIRCLECI_REDIRECT_URI,
      challenge,
      state: oauthState,
    });
    const sealed = await seal(await this.dataKey(), verifier, verifierContext(circleCIAuthorizationId));
    const dueAt = now + REDIRECT_BUDGET_SECONDS * 1000;
    this.ctx.storage.sql.exec(
      `INSERT INTO circleci_authorizations (circleci_authorization_id, principal_id, client_id, redirect_uri, authorize_url,
      oauth_state, phase, phase_due_at, verifier_sealed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'AwaitingRedirect', ?, ?, ?, ?)`,
      circleCIAuthorizationId,
      principalId,
      client.clientId,
      CIRCLECI_REDIRECT_URI,
      url,
      oauthState,
      dueAt,
      sealed,
      now,
      now,
    );
    await this.circleCIAuthorizationTimer(tenantId, circleCIAuthorizationId, dueAt);
    return { kind: "Started", authorization: this.presentCircleCIAuthorization(tenantId, circleCIAuthorizationId) };
  }

  async completeCircleCIAuthorization(
    tenantId: string,
    principalId: string,
    circleCIAuthorizationId: string,
    redirectedUrl: string,
    now: number,
  ): Promise<CircleCIAuthorizationStepped> {
    const row = await this.ownCircleCIAuthorization(tenantId, principalId, circleCIAuthorizationId, now);
    if (row === null) return { kind: "NotFound" };
    const step = advanceAuthorization(circleCIAuthorizationId, phaseOf(row), { kind: "Redirected" });
    if (step.kind === "Refuse") return { kind: "NotWaiting", detail: step.detail };
    const redirect = parseRedirect(redirectedUrl, row.redirect_uri);
    if (redirect.kind === "Invalid") return { kind: "Invalid", detail: redirect.detail };
    if (this.exchanging.has(circleCIAuthorizationId)) {
      return {
        kind: "NotWaiting",
        detail: `CircleCI authorization ${circleCIAuthorizationId} is already spending a redirect address`,
      };
    }
    this.exchanging.add(circleCIAuthorizationId);
    const settled = await this.redeemCircleCIRedirect(tenantId, row, redirect, now).finally(() =>
      this.exchanging.delete(circleCIAuthorizationId),
    );
    return settled;
  }

  private async redeemCircleCIRedirect(
    tenantId: string,
    row: CircleCIAuthorizationRow,
    redirect: Exclude<ReturnType<typeof parseRedirect>, { kind: "Invalid" }>,
    now: number,
  ): Promise<CircleCIAuthorizationStepped> {
    const id = row.circleci_authorization_id;
    const fail = async (reason: CircleCIAuthorizationFailureReason, detail: string) => {
      await this.failCircleCIAuthorization(tenantId, id, reason, detail, Date.now());
      return { kind: "Stepped", authorization: this.presentCircleCIAuthorization(tenantId, id) } as const;
    };
    if (!sameSecret(redirect.state, row.oauth_state)) return fail("StateMismatch", stateMismatchDetail(id));
    if (redirect.kind === "Denied") return fail("AccessDenied", deniedDetail(redirect));
    const [sealed] = this.ctx.storage.sql
      .exec<{ verifier_sealed: string | null }>(
        "SELECT verifier_sealed FROM circleci_authorizations WHERE circleci_authorization_id = ?",
        id,
      )
      .toArray();
    if (sealed?.verifier_sealed == null) {
      return { kind: "NotWaiting", detail: `CircleCI authorization ${id} ended while its redirect address arrived` };
    }
    const verifier = await unseal(
      await this.dataKey(),
      sealed.verifier_sealed,
      verifierContext(id),
      "connect CircleCI again from the dashboard or with tumpel circleci authorize",
    );
    const exchanged = await exchangeCode(fetcher, this.env.CIRCLECI_APP_ORIGIN, {
      code: redirect.code,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      verifier,
    });
    if (exchanged.kind === "Refused") return fail("CodeRefused", exchanged.detail);
    if (exchanged.kind === "Failed") return fail("ExchangeFailed", exchanged.detail);
    const read = await readCollaborations(fetcher, this.env.CIRCLECI_API_ORIGIN, exchanged.token);
    if (!read.ok) {
      return fail(
        "ExchangeFailed",
        `${read.detail}, reading the organizations of the new token; connect CircleCI again from the dashboard or with tumpel circleci authorize`,
      );
    }
    const organizations = organizationsOf(read.value);
    if (organizations.length === 0) {
      return fail(
        "NoOrganization",
        "the new token reads no CircleCI organization; join an organization on CircleCI, or authorize the organization in the SSO section of CircleCI's consent page, then connect CircleCI again",
      );
    }
    const expiresAt = now + exchanged.expiresInSeconds * 1000;
    const [only] = organizations;
    if (organizations.length === 1 && only !== undefined) {
      return this.connectChosenOrganization(
        tenantId,
        id,
        only,
        await this.sealCircleCIToken(exchanged.token),
        expiresAt,
      );
    }
    const sealedToken = await seal(await this.dataKey(), exchanged.token, tokenContext(id));
    const dueAt = Date.now() + CHOOSE_BUDGET_SECONDS * 1000;
    const moved = this.ctx.storage.sql.exec(
      `UPDATE circleci_authorizations SET phase = 'ChoosingOrganization', verifier_sealed = NULL, token_sealed = ?,
      token_expires_at = ?, organizations = ?, phase_due_at = ?, updated_at = ?
      WHERE circleci_authorization_id = ? AND phase = 'AwaitingRedirect'`,
      sealedToken,
      expiresAt,
      JSON.stringify(organizations),
      dueAt,
      Date.now(),
      id,
    ).rowsWritten;
    if (moved === 0)
      return { kind: "NotWaiting", detail: `CircleCI authorization ${id} ended while its code was spent` };
    await this.circleCIAuthorizationTimer(tenantId, id, dueAt);
    return { kind: "Stepped", authorization: this.presentCircleCIAuthorization(tenantId, id) };
  }

  private async connectChosenOrganization(
    tenantId: string,
    circleCIAuthorizationId: string,
    organization: CircleCIOrganization,
    sealedToken: string,
    expiresAt: number,
  ): Promise<CircleCIAuthorizationStepped> {
    const now = Date.now();
    const completed = this.ctx.storage.transactionSync(() => {
      const moved = this.ctx.storage.sql.exec(
        `UPDATE circleci_authorizations SET phase = 'Completed', verifier_sealed = NULL, token_sealed = NULL,
        token_expires_at = ?, organization_id = ?, account_label = ?, ended_at = ?, updated_at = ?
        WHERE circleci_authorization_id = ? AND phase IN ${LIVE_PHASES}`,
        expiresAt,
        organization.organizationId,
        organization.name,
        now,
        now,
        circleCIAuthorizationId,
      ).rowsWritten;
      if (moved === 0) return false;
      this.writeCircleCIConnectionRows(
        { accountLabel: organization.name, organizationId: organization.organizationId, sealedToken, expiresAt },
        now,
      );
      return true;
    });
    if (!completed) {
      return {
        kind: "NotWaiting",
        detail: `CircleCI authorization ${circleCIAuthorizationId} ended before the connection took its token`,
      };
    }
    await this.circleCIAuthorizationTimer(tenantId, circleCIAuthorizationId, null);
    return { kind: "Stepped", authorization: this.presentCircleCIAuthorization(tenantId, circleCIAuthorizationId) };
  }

  async chooseCircleCIOrganization(
    tenantId: string,
    principalId: string,
    circleCIAuthorizationId: string,
    organizationId: string,
    now: number,
  ): Promise<CircleCIAuthorizationStepped> {
    const row = await this.ownCircleCIAuthorization(tenantId, principalId, circleCIAuthorizationId, now);
    if (row === null) return { kind: "NotFound" };
    const step = advanceAuthorization(circleCIAuthorizationId, phaseOf(row), { kind: "Chosen" });
    if (step.kind === "Refuse") return { kind: "NotWaiting", detail: step.detail };
    const organizations = OrganizationsSchema.parse(JSON.parse(required(row.organizations, "organizations", row)));
    const organization = organizations.find((each) => each.organizationId === organizationId);
    if (organization === undefined) {
      return {
        kind: "Invalid",
        detail: `CircleCI authorization ${circleCIAuthorizationId} lists no organization ${organizationId}; choose one of ${organizations.map((each) => `${each.name} (${each.organizationId})`).join(", ")}`,
      };
    }
    const [sealed] = this.ctx.storage.sql
      .exec<{ token_sealed: string | null }>(
        "SELECT token_sealed FROM circleci_authorizations WHERE circleci_authorization_id = ?",
        circleCIAuthorizationId,
      )
      .toArray();
    const token = await unseal(
      await this.dataKey(),
      required(sealed?.token_sealed ?? null, "token_sealed", row),
      tokenContext(circleCIAuthorizationId),
      "connect CircleCI again from the dashboard or with tumpel circleci authorize",
    );
    return this.connectChosenOrganization(
      tenantId,
      circleCIAuthorizationId,
      organization,
      await this.sealCircleCIToken(token),
      required(row.token_expires_at, "token_expires_at", row),
    );
  }

  async circleCIAuthorizationDeadlineReached(deadline: CircleCIAuthorizationDeadline): Promise<void> {
    const row = this.circleCIAuthorizationRow(deadline.circleCIAuthorizationId);
    if (row === null || row.phase_due_at !== deadline.at) return;
    const step = advanceAuthorization(row.circleci_authorization_id, phaseOf(row), { kind: "Deadline" });
    if (step.kind !== "Fail") return;
    this.ctx.storage.sql.exec(
      `UPDATE circleci_authorizations SET phase = 'Failed', reason = ?, detail = ?, verifier_sealed = NULL, token_sealed = NULL,
      ended_at = ?, updated_at = ? WHERE circleci_authorization_id = ? AND phase IN ${LIVE_PHASES}`,
      step.reason,
      step.detail,
      Date.now(),
      Date.now(),
      row.circleci_authorization_id,
    );
  }
}
