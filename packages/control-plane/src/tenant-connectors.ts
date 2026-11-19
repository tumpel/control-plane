import {
  type ConnectorAccessTokenSchema,
  type ConnectorAuthorizationSchema,
  ConnectorSchema,
  type ConnectorStatusSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import {
  authorizeUrl,
  type Bundle,
  BundleSchema,
  CALLBACK_BUDGET_MS,
  CALLBACK_PATH,
  discover,
  exchangeCode,
  needsRefresh,
  pkcePair,
  refreshBundle,
  register,
  STATE_PURPOSE,
  type StateClaims,
  singleFlight,
} from "./connector-oauth.ts";
import { releaseConnectorCredentials } from "./connector-rows.ts";
import { sha256Hex } from "./crypto.ts";
import { seal, unseal } from "./envelope.ts";
import { type Fetch, signState } from "./github.ts";
import { keyStoreOf } from "./key-store.ts";
import { TenantOpenRouterAuthorizations } from "./tenant-openrouter-authorizations";

export type Connector = z.infer<typeof ConnectorSchema>;
export type ConnectorAuthorization = z.infer<typeof ConnectorAuthorizationSchema>;
export type ConnectorAccessToken = z.infer<typeof ConnectorAccessTokenSchema>;
type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;
type FailureReason = Extract<ConnectorStatus, { state: "AuthorizationFailed" }>["reason"];

export type ConnectorWritten = { kind: "Written"; connector: Connector } | { kind: "NotFound" } | { kind: "NameTaken" };
export type ConnectorDeleted = { kind: "Deleted" } | { kind: "NotFound" } | { kind: "InUse"; detail: string };
export type ConnectorAuthorizeStarted =
  | { kind: "Started"; authorization: ConnectorAuthorization }
  | { kind: "NotFound" }
  | { kind: "DiscoveryFailed" | "RegistrationUnsupported"; detail: string };
export type ConnectorCallbackSettled = { kind: "Connected"; name: string } | { kind: "NotConnected"; detail: string };
export type ConnectorCallback =
  | { kind: "Code"; code: string; issuer: string | null }
  | { kind: "Error"; error: string };
export type ConnectorTokenServed =
  | { kind: "Served"; token: ConnectorAccessToken }
  | { kind: "Refused" }
  | { kind: "NotRunning" }
  | { kind: "NoCredential"; name: string }
  | { kind: "RefreshFailed"; detail: string };

type NameRow = {
  connector_id: string;
  name: string;
  url: string;
  auth: "Static" | "OAuth";
  created_at: number;
  updated_at: number;
};
type GrantRow = {
  issuer: string;
  token_endpoint: string;
  client_id: string;
  resource: string;
  bundle_sealed: string;
  updated_at: number;
};
type AuthorizationRow = {
  connector_authorization_id: string;
  connector_id: string;
  principal_id: string;
  issuer: string;
  token_endpoint: string;
  client_id: string;
  resource: string;
  redirect_uri: string;
  verifier_sealed: string;
  callback_due_at: number;
};

const NAME_SELECT = `SELECT n.connector_id, n.name, COALESCE(s.url, o.url) AS url,
  CASE WHEN s.connector_id IS NULL THEN 'OAuth' ELSE 'Static' END AS auth, n.created_at, n.updated_at
  FROM connector_names n LEFT JOIN static_connectors s USING (connector_id) LEFT JOIN oauth_connectors o USING (connector_id)`;

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

const credentialContext = (connectorId: string): string => `connector/${connectorId}/credential`;
const verifierContext = (connectorId: string): string => `connector/${connectorId}/verifier`;

const RECONNECT = "an Owner authorizes the connector again with tumpel connector authorize";

const fetcher: Fetch = (url, init) => fetch(url, init);

export class TenantConnectors extends TenantOpenRouterAuthorizations {
  private readonly refreshes = new Map<string, Promise<ConnectorTokenServed>>();

  private connectorRow(connectorId: string): NameRow | null {
    const [row] = this.ctx.storage.sql.exec<NameRow>(`${NAME_SELECT} WHERE n.connector_id = ?`, connectorId).toArray();
    return row ?? null;
  }

  private connectorStatus(connectorId: string, now: number): ConnectorStatus {
    const sql = this.ctx.storage.sql;
    const [disconnected] = sql
      .exec<{ disconnected_at: number }>(
        "SELECT disconnected_at FROM connector_disconnections WHERE connector_id = ?",
        connectorId,
      )
      .toArray();
    if (disconnected !== undefined) return { state: "Disconnected", disconnectedAt: iso(disconnected.disconnected_at) };
    const [connected] = sql
      .exec<{ connected_at: number }>(
        `SELECT connected_at FROM static_connector_tokens WHERE connector_id = ?1
        UNION ALL SELECT connected_at FROM oauth_connector_grants WHERE connector_id = ?1`,
        connectorId,
      )
      .toArray();
    if (connected !== undefined) return { state: "Connected", connectedAt: iso(connected.connected_at) };
    const [failure] = sql
      .exec<{ reason: FailureReason; detail: string; failed_at: number }>(
        "SELECT reason, detail, failed_at FROM connector_authorization_failures WHERE connector_id = ?",
        connectorId,
      )
      .toArray();
    if (failure !== undefined) {
      return {
        state: "AuthorizationFailed",
        reason: failure.reason,
        detail: failure.detail,
        failedAt: iso(failure.failed_at),
      };
    }
    const [lapsed] = sql
      .exec<{ callback_due_at: number }>(
        "SELECT callback_due_at FROM connector_authorizations WHERE connector_id = ? AND callback_due_at <= ?",
        connectorId,
        now,
      )
      .toArray();
    if (lapsed !== undefined) {
      return {
        state: "AuthorizationFailed",
        reason: "AuthorizationExpired",
        detail: `no consent reached the control plane within ${CALLBACK_BUDGET_MS / 60_000} minutes; ${RECONNECT} and approve in the browser within that time`,
        failedAt: iso(lapsed.callback_due_at),
      };
    }
    return { state: "NotConnected" };
  }

  private presentConnector(tenantId: string, row: NameRow, now: number): Connector {
    return ConnectorSchema.parse({
      auth: row.auth,
      connectorId: row.connector_id,
      tenantId,
      name: row.name,
      url: row.url,
      status: this.connectorStatus(row.connector_id, now),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  listConnectors(tenantId: string, now: number): Connector[] {
    return this.ctx.storage.sql
      .exec<NameRow>(`${NAME_SELECT} ORDER BY n.name`)
      .toArray()
      .map((row) => this.presentConnector(tenantId, row, now));
  }

  getConnector(tenantId: string, connectorId: string, now: number): Connector | null {
    const row = this.connectorRow(connectorId);
    return row === null ? null : this.presentConnector(tenantId, row, now);
  }

  private nameTaken(name: string, connectorId: string): boolean {
    const [row] = this.ctx.storage.sql
      .exec("SELECT 1 FROM connector_names WHERE name = ? AND connector_id != ?", name, connectorId)
      .toArray();
    return row !== undefined;
  }

  createConnector(
    tenantId: string,
    auth: "Static" | "OAuth",
    name: string,
    url: string,
    now: number,
  ): ConnectorWritten {
    const connectorId = crypto.randomUUID();
    if (this.nameTaken(name, connectorId)) return { kind: "NameTaken" };
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        "INSERT INTO connector_names (connector_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        connectorId,
        name,
        now,
        now,
      );
      sql.exec(
        `INSERT INTO ${auth === "Static" ? "static_connectors" : "oauth_connectors"} (connector_id, url) VALUES (?, ?)`,
        connectorId,
        url,
      );
    });
    return this.written(tenantId, connectorId, now);
  }

  private written(tenantId: string, connectorId: string, now: number): ConnectorWritten {
    const connector = this.getConnector(tenantId, connectorId, now);
    return connector === null ? { kind: "NotFound" } : { kind: "Written", connector };
  }

  renameConnector(tenantId: string, connectorId: string, name: string, now: number): ConnectorWritten {
    if (this.nameTaken(name, connectorId)) return { kind: "NameTaken" };
    const renamed = this.ctx.storage.sql.exec(
      "UPDATE connector_names SET name = ?, updated_at = ? WHERE connector_id = ?",
      name,
      now,
      connectorId,
    ).rowsWritten;
    return renamed === 0 ? { kind: "NotFound" } : this.written(tenantId, connectorId, now);
  }

  private runningTurnsUsing(connectorId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        `SELECT t.turn_id FROM turns t JOIN session_connectors sc ON sc.session_id = t.session_id
        WHERE sc.connector_id = ? AND t.state = 'Running' ORDER BY t.turn_id`,
        connectorId,
      )
      .toArray()
      .map((row) => row.turn_id);
  }

  deleteConnector(connectorId: string): ConnectorDeleted {
    const sql = this.ctx.storage.sql;
    if (this.connectorRow(connectorId) === null) return { kind: "NotFound" };
    const personas = sql
      .exec<{ name: string }>(
        "SELECT p.name FROM personas p JOIN persona_connectors pc USING (persona_id) WHERE pc.connector_id = ? ORDER BY p.name",
        connectorId,
      )
      .toArray()
      .map((row) => row.name);
    if (personas.length > 0) return { kind: "InUse", detail: `the persona ${personas.join(", ")} lists it` };
    const turns = this.runningTurnsUsing(connectorId);
    if (turns.length > 0) return { kind: "InUse", detail: `the running turn ${turns.join(", ")} uses it` };
    sql.exec("DELETE FROM connector_names WHERE connector_id = ?", connectorId);
    return { kind: "Deleted" };
  }

  async setStaticToken(tenantId: string, connectorId: string, value: string, now: number): Promise<ConnectorWritten> {
    const row = this.connectorRow(connectorId);
    if (row === null || row.auth !== "Static") return { kind: "NotFound" };
    const sealed = await seal(await this.dataKey(), value, credentialContext(connectorId));
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO static_connector_tokens (connector_id, token_sealed, connected_at) VALUES (?, ?, ?)
        ON CONFLICT (connector_id) DO UPDATE SET token_sealed = excluded.token_sealed, connected_at = excluded.connected_at`,
        connectorId,
        sealed,
        now,
      );
      sql.exec("DELETE FROM connector_disconnections WHERE connector_id = ?", connectorId);
      sql.exec("UPDATE connector_names SET updated_at = ? WHERE connector_id = ?", now, connectorId);
    });
    return this.written(tenantId, connectorId, now);
  }

  clearConnectorCredential(tenantId: string, connectorId: string, now: number): ConnectorWritten {
    if (this.connectorRow(connectorId) === null) return { kind: "NotFound" };
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM connector_authorizations WHERE connector_id = ?", connectorId);
      sql.exec(
        "INSERT INTO connector_disconnections (connector_id, disconnected_at) VALUES (?, ?) ON CONFLICT (connector_id) DO NOTHING",
        connectorId,
        now,
      );
      sql.exec("UPDATE connector_names SET updated_at = ? WHERE connector_id = ?", now, connectorId);
      releaseConnectorCredentials(sql);
    });
    return this.written(tenantId, connectorId, now);
  }

  async startConnectorAuthorization(
    tenantId: string,
    principalId: string,
    connectorId: string,
    controlPlaneOrigin: string,
    now: number,
  ): Promise<ConnectorAuthorizeStarted> {
    const row = this.connectorRow(connectorId);
    if (row === null || row.auth !== "OAuth") return { kind: "NotFound" };
    const found = await discover(fetcher, row.url);
    if (found.kind !== "Discovered") return found;
    const { discovered } = found;
    const redirectUri = `${controlPlaneOrigin}${CALLBACK_PATH}`;
    const registered = await register(fetcher, discovered.registrationEndpoint, redirectUri);
    if (registered.kind !== "Registered") return registered;
    const connectorAuthorizationId = crypto.randomUUID();
    const claims: StateClaims = {
      purpose: "ConnectorAuthorization",
      tenantId,
      connectorId,
      connectorAuthorizationId,
      principalId,
    };
    const state = await signState(await keyStoreOf(this.env).signingKey(STATE_PURPOSE), claims);
    const { verifier, challenge } = await pkcePair();
    const sealed = await seal(await this.dataKey(), verifier, verifierContext(connectorId));
    const dueAt = now + CALLBACK_BUDGET_MS;
    const stateHash = await sha256Hex(state);
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM connector_authorizations WHERE connector_id = ?", connectorId);
      sql.exec(
        `INSERT INTO connector_authorizations (connector_authorization_id, connector_id, principal_id, state_hash, issuer,
        token_endpoint, client_id, resource, redirect_uri, verifier_sealed, callback_due_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        connectorAuthorizationId,
        connectorId,
        principalId,
        stateHash,
        discovered.issuer,
        discovered.tokenEndpoint,
        registered.clientId,
        discovered.resource,
        redirectUri,
        sealed,
        dueAt,
        now,
      );
    });
    return {
      kind: "Started",
      authorization: {
        connectorAuthorizationId,
        connectorId,
        authorizeUrl: authorizeUrl(discovered, { clientId: registered.clientId, redirectUri, challenge, state }),
        callbackDueAt: iso(dueAt),
      },
    };
  }

  private failConnectorAuthorization(
    connectorId: string,
    reason: FailureReason,
    detail: string,
    now: number,
  ): ConnectorCallbackSettled {
    this.ctx.storage.sql.exec(
      `INSERT INTO connector_authorization_failures (connector_id, reason, detail, failed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (connector_id) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, failed_at = excluded.failed_at`,
      connectorId,
      reason,
      detail,
      now,
    );
    return { kind: "NotConnected", detail };
  }

  async connectorCallback(
    claims: StateClaims,
    stateHash: string,
    callback: ConnectorCallback,
    initiatorIsOwner: boolean,
    now: number,
  ): Promise<ConnectorCallbackSettled> {
    const sql = this.ctx.storage.sql;
    const [attempt] = sql
      .exec<AuthorizationRow>(
        `SELECT connector_authorization_id, connector_id, principal_id, issuer, token_endpoint, client_id, resource,
        redirect_uri, verifier_sealed, callback_due_at FROM connector_authorizations
        WHERE state_hash = ? AND connector_authorization_id = ? AND connector_id = ?`,
        stateHash,
        claims.connectorAuthorizationId,
        claims.connectorId,
      )
      .toArray();
    if (attempt === undefined) {
      return {
        kind: "NotConnected",
        detail: `this authorization was already used, replaced by a newer one or cancelled; ${RECONNECT}`,
      };
    }
    sql.exec(
      "DELETE FROM connector_authorizations WHERE connector_authorization_id = ?",
      attempt.connector_authorization_id,
    );
    const { connector_id: connectorId } = attempt;
    if (now > attempt.callback_due_at) {
      return this.failConnectorAuthorization(
        connectorId,
        "AuthorizationExpired",
        `consent arrived after the ${CALLBACK_BUDGET_MS / 60_000} minutes an authorization lasts; ${RECONNECT} and approve within that time`,
        now,
      );
    }
    if (!initiatorIsOwner) {
      return this.failConnectorAuthorization(
        connectorId,
        "AuthorizationDenied",
        `the person who started this authorization is no longer an Owner of the tenant; ${RECONNECT}`,
        now,
      );
    }
    if (callback.kind === "Error") {
      return this.failConnectorAuthorization(
        connectorId,
        "AuthorizationDenied",
        `the provider answered ${callback.error} instead of a code, as it does when consent is declined; ${RECONNECT} and approve the request`,
        now,
      );
    }
    if (callback.issuer !== null && callback.issuer !== attempt.issuer) {
      return this.failConnectorAuthorization(
        connectorId,
        "AuthorizationDenied",
        `the callback names the issuer ${callback.issuer}, and this authorization went to ${attempt.issuer}; ${RECONNECT}`,
        now,
      );
    }
    const verifier = await unseal(
      await this.dataKey(),
      attempt.verifier_sealed,
      verifierContext(connectorId),
      RECONNECT,
    );
    const endpoints = { issuer: attempt.issuer, resource: attempt.resource, tokenEndpoint: attempt.token_endpoint };
    const exchanged = await exchangeCode(
      fetcher,
      endpoints,
      { clientId: attempt.client_id, code: callback.code, verifier, redirectUri: attempt.redirect_uri },
      now,
    );
    if (exchanged.kind !== "Issued") {
      return this.failConnectorAuthorization(
        connectorId,
        "TokenExchangeFailed",
        `${exchanged.detail}; ${RECONNECT}`,
        now,
      );
    }
    const sealed = await seal(await this.dataKey(), JSON.stringify(exchanged.bundle), credentialContext(connectorId));
    const stored = Date.now();
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO oauth_connector_grants (connector_id, issuer, token_endpoint, client_id, resource, bundle_sealed, connected_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (connector_id) DO UPDATE SET issuer = excluded.issuer, token_endpoint = excluded.token_endpoint,
        client_id = excluded.client_id, resource = excluded.resource, bundle_sealed = excluded.bundle_sealed,
        connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
        connectorId,
        attempt.issuer,
        attempt.token_endpoint,
        attempt.client_id,
        attempt.resource,
        sealed,
        stored,
        stored,
      );
      sql.exec("DELETE FROM connector_authorization_failures WHERE connector_id = ?", connectorId);
      sql.exec("DELETE FROM connector_disconnections WHERE connector_id = ?", connectorId);
      sql.exec("UPDATE connector_names SET updated_at = ? WHERE connector_id = ?", stored, connectorId);
    });
    return { kind: "Connected", name: this.connectorRow(connectorId)?.name ?? connectorId };
  }

  async serveConnectorToken(turnId: string, connectorId: string, now: number): Promise<ConnectorTokenServed> {
    const sql = this.ctx.storage.sql;
    const [turn] = sql
      .exec<{ state: string }>(
        `SELECT t.state FROM turns t JOIN session_connectors sc ON sc.session_id = t.session_id
        WHERE t.turn_id = ? AND sc.connector_id = ?`,
        turnId,
        connectorId,
      )
      .toArray();
    if (turn === undefined) return { kind: "Refused" };
    if (turn.state !== "Running") return { kind: "NotRunning" };
    const row = this.connectorRow(connectorId);
    if (row === null) return { kind: "Refused" };
    if (row.auth === "OAuth") {
      return singleFlight(this.refreshes, connectorId, () => this.oauthToken(connectorId, row.name, now));
    }
    const [token] = sql
      .exec<{ token_sealed: string }>(
        "SELECT token_sealed FROM static_connector_tokens WHERE connector_id = ?",
        connectorId,
      )
      .toArray();
    if (token === undefined) return { kind: "NoCredential", name: row.name };
    const accessToken = await unseal(
      await this.dataKey(),
      token.token_sealed,
      credentialContext(connectorId),
      RECONNECT,
    );
    return { kind: "Served", token: { accessToken } };
  }

  private async oauthToken(connectorId: string, name: string, now: number): Promise<ConnectorTokenServed> {
    const sql = this.ctx.storage.sql;
    const [grant] = sql
      .exec<GrantRow>(
        "SELECT issuer, token_endpoint, client_id, resource, bundle_sealed, updated_at FROM oauth_connector_grants WHERE connector_id = ?",
        connectorId,
      )
      .toArray();
    if (grant === undefined) return { kind: "NoCredential", name };
    const bundle = BundleSchema.parse(
      JSON.parse(await unseal(await this.dataKey(), grant.bundle_sealed, credentialContext(connectorId), RECONNECT)),
    );
    if (!needsRefresh(bundle, now)) return this.served(bundle, name, now);
    if (bundle.kind !== "Refreshable")
      throw new Error(`connector ${connectorId} needs a refresh and holds no refresh token`);
    const endpoints = { issuer: grant.issuer, resource: grant.resource, tokenEndpoint: grant.token_endpoint };
    const refreshed = await refreshBundle(fetcher, endpoints, grant.client_id, bundle.refreshToken, now);
    if (refreshed.kind === "InvalidGrant") {
      const detail = `${grant.issuer} refused the stored grant of connector ${name}; ${RECONNECT}`;
      this.ctx.storage.transactionSync(() => {
        sql.exec("DELETE FROM oauth_connector_grants WHERE connector_id = ?", connectorId);
        this.failConnectorAuthorization(connectorId, "RefreshRefused", detail, Date.now());
      });
      return { kind: "RefreshFailed", detail };
    }
    if (refreshed.kind !== "Issued") {
      return { kind: "RefreshFailed", detail: `the refresh of connector ${name} failed: ${refreshed.detail}` };
    }
    const sealed = await seal(await this.dataKey(), JSON.stringify(refreshed.bundle), credentialContext(connectorId));
    sql.exec(
      "UPDATE oauth_connector_grants SET bundle_sealed = ?, updated_at = ? WHERE connector_id = ? AND updated_at = ?",
      sealed,
      Date.now(),
      connectorId,
      grant.updated_at,
    );
    return this.served(refreshed.bundle, name, now);
  }

  private served(bundle: Bundle, name: string, now: number): ConnectorTokenServed {
    if (bundle.expiresAt === null) return { kind: "Served", token: { accessToken: bundle.accessToken } };
    if (bundle.expiresAt <= now) {
      return {
        kind: "RefreshFailed",
        detail: `the access token of connector ${name} expired and the provider gave no refresh token; ${RECONNECT}`,
      };
    }
    return { kind: "Served", token: { accessToken: bundle.accessToken, expiresAt: iso(bundle.expiresAt) } };
  }

  unknownConnectors(connectorIds: readonly string[]): string[] {
    const known = new Set(
      this.ctx.storage.sql
        .exec<{ connector_id: string }>("SELECT connector_id FROM connector_names")
        .toArray()
        .map((row) => row.connector_id),
    );
    return connectorIds.filter((connectorId) => !known.has(connectorId));
  }
}
