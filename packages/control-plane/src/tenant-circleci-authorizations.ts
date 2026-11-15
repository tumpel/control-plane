import { CircleCIAuthorizationSchema, CircleCIOrganizationSchema } from "@tumpel/api/schemas";
import { z } from "zod";
import { readCollaborations } from "./circleci.ts";
import {
  authorizeUrl,
  CHOOSE_BUDGET_SECONDS,
  CIRCLECI_REDIRECT_URI,
  type CircleCIAuthorization,
  type CircleCIAuthorizationFailureReason,
  type CircleCIOrganization,
  deniedDetail,
  exchangeCode,
  organizationsOf,
  parseRedirect,
  REDIRECT_BUDGET_SECONDS,
  registerClient,
  stateMismatchDetail,
  timedOutDetail,
} from "./circleci-oauth.ts";
import { base64Url, randomToken, sameSecret } from "./crypto";
import { seal, unseal } from "./envelope.ts";
import type { Fetch } from "./github.ts";
import type { CircleCIAuthorizationDeadline } from "./session-timer";
import { TenantClaudeSetups } from "./tenant-claude-setups";

type AuthorizationRow = {
  circleci_authorization_id: string;
  principal_id: string;
  client_id: string;
  authorize_url: string;
  oauth_state: string;
  verifier_sealed: string;
  phase: string;
  phase_due_at: number;
  created_at: number;
  updated_at: number;
};

type TokenRow = { token_sealed: string; expires_at: number; organizations: string };
type CompletionRow = { organization_id: string; account_label: string; expires_at: number; ended_at: number };
type FailureRow = { reason: string; detail: string; ended_at: number };

export type CircleCIAuthorizationStarted =
  | { kind: "Started"; authorization: CircleCIAuthorization }
  | { kind: "RegistrationRefused"; detail: string };

export type CircleCIAuthorizationStepped =
  | { kind: "Stepped"; authorization: CircleCIAuthorization }
  | { kind: "NotFound" }
  | { kind: "NotWaiting"; detail: string }
  | { kind: "Invalid"; detail: string };

const LIVE_PHASES = "('AwaitingRedirect', 'Exchanging', 'ChoosingOrganization')";
const AUTHORIZE_AGAIN = "connect CircleCI again from the dashboard or with tumpel circleci authorize";

const OrganizationsSchema = z.array(CircleCIOrganizationSchema);

const verifierContext = (circleCIAuthorizationId: string): string =>
  `circleci-authorization/${circleCIAuthorizationId}/verifier`;
const tokenContext = (circleCIAuthorizationId: string): string =>
  `circleci-authorization/${circleCIAuthorizationId}/token`;

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

const fetcher: Fetch = (url, init) => fetch(url, init);

const pkcePair = async (): Promise<{ verifier: string; challenge: string }> => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64Url(digest) };
};

const notWaiting = (circleCIAuthorizationId: string, takes: string): CircleCIAuthorizationStepped => ({
  kind: "NotWaiting",
  detail: `CircleCI authorization ${circleCIAuthorizationId} ended, ran out of time or is busy, and takes no ${takes}`,
});

export class TenantCircleCIAuthorizations extends TenantClaudeSetups {
  private one<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T | null {
    const [row] = this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
    return row ?? null;
  }

  private authorizationRow(circleCIAuthorizationId: string): AuthorizationRow | null {
    return this.one<AuthorizationRow>(
      "SELECT * FROM circleci_authorizations WHERE circleci_authorization_id = ?",
      circleCIAuthorizationId,
    );
  }

  private statusOf(row: AuthorizationRow): unknown {
    const id = row.circleci_authorization_id;
    if (row.phase === "ChoosingOrganization") {
      const token = this.one<TokenRow>(
        "SELECT * FROM circleci_authorization_tokens WHERE circleci_authorization_id = ?",
        id,
      );
      if (token === null) throw new Error(`CircleCI authorization ${id} is ChoosingOrganization and holds no token`);
      return {
        state: "ChoosingOrganization",
        organizations: OrganizationsSchema.parse(JSON.parse(token.organizations)),
        chooseDueAt: iso(row.phase_due_at),
      };
    }
    if (row.phase === "Completed") {
      const done = this.one<CompletionRow>(
        "SELECT * FROM circleci_authorization_completions WHERE circleci_authorization_id = ?",
        id,
      );
      if (done === null) throw new Error(`CircleCI authorization ${id} is Completed and has no completion`);
      return {
        state: "Completed",
        organizationId: done.organization_id,
        accountLabel: done.account_label,
        expiresAt: iso(done.expires_at),
        completedAt: iso(done.ended_at),
      };
    }
    if (row.phase === "Failed") {
      const failure = this.one<FailureRow>(
        "SELECT * FROM circleci_authorization_failures WHERE circleci_authorization_id = ?",
        id,
      );
      if (failure === null) throw new Error(`CircleCI authorization ${id} is Failed and has no failure`);
      return { state: "Failed", reason: failure.reason, detail: failure.detail, failedAt: iso(failure.ended_at) };
    }
    return {
      state: "AwaitingRedirect",
      authorizeUrl: row.authorize_url,
      redirectUri: CIRCLECI_REDIRECT_URI,
      redirectDueAt: iso(row.phase_due_at),
    };
  }

  private present(tenantId: string, circleCIAuthorizationId: string): CircleCIAuthorizationStepped {
    const row = this.authorizationRow(circleCIAuthorizationId);
    if (row === null)
      throw new Error(`CircleCI authorization ${circleCIAuthorizationId} vanished while it was read back`);
    const authorization = CircleCIAuthorizationSchema.parse({
      circleCIAuthorizationId,
      tenantId,
      principalId: row.principal_id,
      status: this.statusOf(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    return { kind: "Stepped", authorization };
  }

  private authorizationTimer(tenantId: string, circleCIAuthorizationId: string, at: number | null) {
    return this.env.SESSION_TIMER.getByName(circleCIAuthorizationId).set(tenantId, {
      CircleCIAuthorization: at === null ? null : { circleCIAuthorizationId, at },
    });
  }

  private async failAuthorization(
    tenantId: string,
    circleCIAuthorizationId: string,
    from: string,
    failure: { reason: CircleCIAuthorizationFailureReason; detail: string },
  ): Promise<boolean> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const moved = this.ctx.storage.transactionSync(() => {
      const written = sql.exec(
        `UPDATE circleci_authorizations SET phase = 'Failed', updated_at = ?
        WHERE circleci_authorization_id = ? AND phase IN ${from}`,
        now,
        circleCIAuthorizationId,
      ).rowsWritten;
      if (written === 0) return false;
      sql.exec(
        "DELETE FROM circleci_authorization_tokens WHERE circleci_authorization_id = ?",
        circleCIAuthorizationId,
      );
      sql.exec(
        "INSERT INTO circleci_authorization_failures (circleci_authorization_id, reason, detail, ended_at) VALUES (?, ?, ?, ?)",
        circleCIAuthorizationId,
        failure.reason,
        failure.detail,
        now,
      );
      return true;
    });
    if (moved) await this.authorizationTimer(tenantId, circleCIAuthorizationId, null);
    return moved;
  }

  private async circleCIClientId(): Promise<
    { kind: "Registered"; clientId: string } | { kind: "Refused"; detail: string }
  > {
    const held = this.one<{ client_id: string }>("SELECT client_id FROM circleci_clients WHERE client_slot = 1");
    if (held !== null) return { kind: "Registered", clientId: held.client_id };
    const registered = await registerClient(fetcher, this.env.CIRCLECI_APP_ORIGIN, CIRCLECI_REDIRECT_URI);
    if (registered.kind === "Refused") return registered;
    this.ctx.storage.sql.exec(
      "INSERT INTO circleci_clients (client_slot, client_id, created_at) VALUES (1, ?, ?) ON CONFLICT (client_slot) DO NOTHING",
      registered.clientId,
      Date.now(),
    );
    const kept = this.one<{ client_id: string }>("SELECT client_id FROM circleci_clients WHERE client_slot = 1");
    if (kept === null) throw new Error("the CircleCI client was registered and then not found");
    return { kind: "Registered", clientId: kept.client_id };
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
      `INSERT INTO circleci_authorizations (circleci_authorization_id, principal_id, client_id, authorize_url, oauth_state,
      verifier_sealed, phase, phase_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'AwaitingRedirect', ?, ?, ?)`,
      circleCIAuthorizationId,
      principalId,
      client.clientId,
      url,
      oauthState,
      sealed,
      dueAt,
      now,
      now,
    );
    await this.authorizationTimer(tenantId, circleCIAuthorizationId, dueAt);
    const presented = this.present(tenantId, circleCIAuthorizationId);
    if (presented.kind !== "Stepped")
      throw new Error(`CircleCI authorization ${circleCIAuthorizationId} did not read back`);
    return { kind: "Started", authorization: presented.authorization };
  }

  async completeCircleCIAuthorization(
    tenantId: string,
    principalId: string,
    circleCIAuthorizationId: string,
    redirectedUrl: string,
    now: number,
  ): Promise<CircleCIAuthorizationStepped> {
    const row = this.authorizationRow(circleCIAuthorizationId);
    if (row === null || row.principal_id !== principalId) return { kind: "NotFound" };
    const redirect = parseRedirect(redirectedUrl, CIRCLECI_REDIRECT_URI);
    if (redirect.kind === "Invalid") return { kind: "Invalid", detail: redirect.detail };
    if (!sameSecret(redirect.state, row.oauth_state)) {
      return { kind: "Invalid", detail: stateMismatchDetail(circleCIAuthorizationId) };
    }
    if (redirect.kind === "Denied") {
      const failed = await this.failAuthorization(tenantId, circleCIAuthorizationId, "('AwaitingRedirect')", {
        reason: "AccessDenied",
        detail: deniedDetail(redirect),
      });
      return failed
        ? this.present(tenantId, circleCIAuthorizationId)
        : notWaiting(circleCIAuthorizationId, "redirect address");
    }
    const claimed = this.ctx.storage.sql.exec(
      `UPDATE circleci_authorizations SET phase = 'Exchanging', updated_at = ?
      WHERE circleci_authorization_id = ? AND phase = 'AwaitingRedirect' AND phase_due_at > ?`,
      now,
      circleCIAuthorizationId,
      now,
    ).rowsWritten;
    if (claimed === 0) return notWaiting(circleCIAuthorizationId, "redirect address");
    return this.exchange(tenantId, row, redirect.code, now);
  }

  private async exchange(
    tenantId: string,
    row: AuthorizationRow,
    code: string,
    now: number,
  ): Promise<CircleCIAuthorizationStepped> {
    const id = row.circleci_authorization_id;
    const fail = async (reason: CircleCIAuthorizationFailureReason, detail: string) =>
      (await this.failAuthorization(tenantId, id, "('Exchanging')", { reason, detail }))
        ? this.present(tenantId, id)
        : notWaiting(id, "redirect address");
    const verifier = await unseal(await this.dataKey(), row.verifier_sealed, verifierContext(id), AUTHORIZE_AGAIN);
    const exchanged = await exchangeCode(fetcher, this.env.CIRCLECI_APP_ORIGIN, {
      code,
      clientId: row.client_id,
      redirectUri: CIRCLECI_REDIRECT_URI,
      verifier,
    });
    if (exchanged.kind === "Refused") return fail("CodeRefused", exchanged.detail);
    if (exchanged.kind === "Failed") return fail("ExchangeFailed", exchanged.detail);
    const expiresAt = now + exchanged.expiresInSeconds * 1000;
    const sealedToken = await this.sealCircleCIToken(exchanged.token);
    const held = this.circleCIConnection();
    const read = await readCollaborations(fetcher, this.env.CIRCLECI_API_ORIGIN, exchanged.token);
    const organizations = read.ok ? organizationsOf(read.value) : [];
    const renewed =
      held === null ? undefined : organizations.find((each) => each.organizationId === held.organizationId);
    if (held !== null && (renewed !== undefined || !read.ok)) {
      const organization = renewed ?? {
        organizationId: held.organizationId,
        name: held.accountLabel,
        slug: held.organizationId,
      };
      return this.connectOrganization(tenantId, id, "('Exchanging')", organization, sealedToken, expiresAt);
    }
    if (!read.ok)
      return fail("ExchangeFailed", `${read.detail}, reading the organizations of the new token; ${AUTHORIZE_AGAIN}`);
    const [only, ...others] = organizations;
    if (only === undefined) {
      return fail(
        "NoOrganization",
        `the new token reads no CircleCI organization; join an organization on CircleCI, or authorize the organization in the SSO section of CircleCI's consent page, then ${AUTHORIZE_AGAIN}`,
      );
    }
    if (others.length === 0)
      return this.connectOrganization(tenantId, id, "('Exchanging')", only, sealedToken, expiresAt);
    return this.awaitChoice(tenantId, id, exchanged.token, expiresAt, organizations);
  }

  private async awaitChoice(
    tenantId: string,
    circleCIAuthorizationId: string,
    token: string,
    expiresAt: number,
    organizations: CircleCIOrganization[],
  ): Promise<CircleCIAuthorizationStepped> {
    const sealed = await seal(await this.dataKey(), token, tokenContext(circleCIAuthorizationId));
    const now = Date.now();
    const dueAt = now + CHOOSE_BUDGET_SECONDS * 1000;
    const sql = this.ctx.storage.sql;
    const moved = this.ctx.storage.transactionSync(() => {
      const written = sql.exec(
        `UPDATE circleci_authorizations SET phase = 'ChoosingOrganization', phase_due_at = ?, updated_at = ?
        WHERE circleci_authorization_id = ? AND phase = 'Exchanging'`,
        dueAt,
        now,
        circleCIAuthorizationId,
      ).rowsWritten;
      if (written === 0) return false;
      sql.exec(
        `INSERT INTO circleci_authorization_tokens (circleci_authorization_id, token_sealed, expires_at, organizations)
        VALUES (?, ?, ?, ?)`,
        circleCIAuthorizationId,
        sealed,
        expiresAt,
        JSON.stringify(organizations),
      );
      return true;
    });
    if (!moved) return notWaiting(circleCIAuthorizationId, "redirect address");
    await this.authorizationTimer(tenantId, circleCIAuthorizationId, dueAt);
    return this.present(tenantId, circleCIAuthorizationId);
  }

  private async connectOrganization(
    tenantId: string,
    circleCIAuthorizationId: string,
    from: string,
    organization: CircleCIOrganization,
    sealedToken: string,
    expiresAt: number,
  ): Promise<CircleCIAuthorizationStepped> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const completed = this.ctx.storage.transactionSync(() => {
      const written = sql.exec(
        `UPDATE circleci_authorizations SET phase = 'Completed', updated_at = ?
        WHERE circleci_authorization_id = ? AND phase IN ${from}`,
        now,
        circleCIAuthorizationId,
      ).rowsWritten;
      if (written === 0) return false;
      sql.exec(
        "DELETE FROM circleci_authorization_tokens WHERE circleci_authorization_id = ?",
        circleCIAuthorizationId,
      );
      sql.exec(
        `INSERT INTO circleci_authorization_completions (circleci_authorization_id, organization_id, account_label,
        expires_at, ended_at) VALUES (?, ?, ?, ?, ?)`,
        circleCIAuthorizationId,
        organization.organizationId,
        organization.name,
        expiresAt,
        now,
      );
      this.writeCircleCIConnectionRows(
        {
          accountLabel: organization.name,
          organizationId: organization.organizationId,
          sealedToken,
          credential: { kind: "Authorized", expiresAt },
        },
        now,
      );
      return true;
    });
    if (!completed) return notWaiting(circleCIAuthorizationId, "token");
    await this.authorizationTimer(tenantId, circleCIAuthorizationId, null);
    return this.present(tenantId, circleCIAuthorizationId);
  }

  async chooseCircleCIOrganization(
    tenantId: string,
    principalId: string,
    circleCIAuthorizationId: string,
    organizationId: string,
    now: number,
  ): Promise<CircleCIAuthorizationStepped> {
    const row = this.authorizationRow(circleCIAuthorizationId);
    if (row === null || row.principal_id !== principalId) return { kind: "NotFound" };
    const token = this.one<TokenRow>(
      `SELECT t.* FROM circleci_authorization_tokens t JOIN circleci_authorizations a USING (circleci_authorization_id)
      WHERE a.circleci_authorization_id = ? AND a.phase = 'ChoosingOrganization' AND a.phase_due_at > ?`,
      circleCIAuthorizationId,
      now,
    );
    if (token === null) return notWaiting(circleCIAuthorizationId, "organization choice");
    const organizations = OrganizationsSchema.parse(JSON.parse(token.organizations));
    const organization = organizations.find((each) => each.organizationId === organizationId);
    if (organization === undefined) {
      return {
        kind: "Invalid",
        detail: `CircleCI authorization ${circleCIAuthorizationId} lists no organization ${organizationId}; choose one of ${organizations.map((each) => `${each.name} (${each.organizationId})`).join(", ")}`,
      };
    }
    const plain = await unseal(
      await this.dataKey(),
      token.token_sealed,
      tokenContext(circleCIAuthorizationId),
      AUTHORIZE_AGAIN,
    );
    return this.connectOrganization(
      tenantId,
      circleCIAuthorizationId,
      "('ChoosingOrganization')",
      organization,
      await this.sealCircleCIToken(plain),
      token.expires_at,
    );
  }

  async circleCIAuthorizationDeadlineReached(tenantId: string, deadline: CircleCIAuthorizationDeadline): Promise<void> {
    const row = this.authorizationRow(deadline.circleCIAuthorizationId);
    if (row === null || row.phase_due_at !== deadline.at) return;
    await this.failAuthorization(tenantId, row.circleci_authorization_id, LIVE_PHASES, {
      reason: "AuthorizationTimedOut",
      detail: timedOutDetail(row.circleci_authorization_id, row.phase),
    });
  }
}
