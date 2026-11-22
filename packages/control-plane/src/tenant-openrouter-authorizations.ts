import { OpenRouterAuthorizationSchema } from "@tumpel/schemas";
import { base64Url } from "./crypto";
import { seal, unseal } from "./envelope.ts";
import { type Fetch, signState } from "./github.ts";
import { keyStoreOf } from "./key-store.ts";
import {
  authorizeUrl,
  CALLBACK_BUDGET_SECONDS,
  CONNECT_AGAIN,
  callbackUrl,
  EXCHANGE_BUDGET_SECONDS,
  exchangeCode,
  exchangeStoppedDetail,
  keyLabelOf,
  notConnectedDetail,
  OPENROUTER_MEMBER,
  OPENROUTER_PROVIDER,
  type OpenRouterAuthorization,
  type OpenRouterAuthorizationFailureReason,
  type OpenRouterCallback,
  STATE_PURPOSE,
  timedOutDetail,
} from "./openrouter-oauth.ts";
import { TenantClaudeSetups } from "./tenant-claude-setups";
import { sealContext } from "./tenant-sessions";

type AuthorizationRow = {
  openrouter_authorization_id: string;
  principal_id: string;
  secret_set_id: string;
  key_label: string;
  created_at: number;
  updated_at: number;
};

type WaitRow = { authorize_url: string; verifier_sealed: string; callback_due_at: number };
type ExchangeRow = { exchange_due_at: number };
type CompletionRow = { completed_at: number };
type FailureRow = { reason: string; detail: string; failed_at: number };

type LivePhaseTable = "openrouter_authorization_waits" | "openrouter_authorization_exchanges";

const WAITS = "openrouter_authorization_waits";
const EXCHANGES = "openrouter_authorization_exchanges";

type Phase =
  | { state: "AwaitingCallback"; wait: WaitRow }
  | { state: "Exchanging"; exchange: ExchangeRow }
  | { state: "Completed"; completion: CompletionRow }
  | { state: "Failed"; failure: FailureRow };

export type NewOpenRouterAuthorization = {
  secretSetId: string;
  controlPlaneOrigin: string;
};

export type OpenRouterAuthorizationStarted =
  | { kind: "Started"; authorization: OpenRouterAuthorization }
  | { kind: "NoSecretSet" }
  | { kind: "OtherCredential"; name: string };

export type OpenRouterAuthorizationRead =
  | { kind: "Found"; authorization: OpenRouterAuthorization }
  | { kind: "NotFound" };

export type OpenRouterCallbackSettled = { kind: "Returned"; secretSetId: string } | { kind: "NotFound" };

const SELECT = `SELECT openrouter_authorization_id, principal_id, secret_set_id, key_label, created_at, updated_at
  FROM openrouter_authorizations`;

const verifierContext = (openRouterAuthorizationId: string): string =>
  `openrouter-authorization/${openRouterAuthorizationId}/verifier`;

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

const fetcher: Fetch = (url, init) => fetch(url, init);

const pkcePair = async (): Promise<{ verifier: string; challenge: string }> => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64Url(digest) };
};

const statusOf = (phase: Phase, keyLabel: string): unknown => {
  if (phase.state === "AwaitingCallback") {
    return {
      state: "AwaitingCallback",
      authorizeUrl: phase.wait.authorize_url,
      callbackDueAt: iso(phase.wait.callback_due_at),
    };
  }
  if (phase.state === "Exchanging") {
    return { state: "Exchanging", exchangeDueAt: iso(phase.exchange.exchange_due_at) };
  }
  if (phase.state === "Completed") {
    return {
      state: "Completed",
      keyLabel,
      completedAt: iso(phase.completion.completed_at),
    };
  }
  return {
    state: "Failed",
    reason: phase.failure.reason,
    detail: phase.failure.detail,
    failedAt: iso(phase.failure.failed_at),
  };
};

export class TenantOpenRouterAuthorizations extends TenantClaudeSetups {
  private openRouterRow(openRouterAuthorizationId: string): AuthorizationRow | null {
    const [row] = this.ctx.storage.sql
      .exec<AuthorizationRow>(`${SELECT} WHERE openrouter_authorization_id = ?`, openRouterAuthorizationId)
      .toArray();
    return row ?? null;
  }

  private openRouterPhase(openRouterAuthorizationId: string): Phase {
    const sql = this.ctx.storage.sql;
    const [wait] = sql
      .exec<WaitRow>(
        "SELECT authorize_url, verifier_sealed, callback_due_at FROM openrouter_authorization_waits WHERE openrouter_authorization_id = ?",
        openRouterAuthorizationId,
      )
      .toArray();
    if (wait !== undefined) return { state: "AwaitingCallback", wait };
    const [exchange] = sql
      .exec<ExchangeRow>(
        "SELECT exchange_due_at FROM openrouter_authorization_exchanges WHERE openrouter_authorization_id = ?",
        openRouterAuthorizationId,
      )
      .toArray();
    if (exchange !== undefined) return { state: "Exchanging", exchange };
    const [completion] = sql
      .exec<CompletionRow>(
        "SELECT completed_at FROM openrouter_authorization_completions WHERE openrouter_authorization_id = ?",
        openRouterAuthorizationId,
      )
      .toArray();
    if (completion !== undefined) return { state: "Completed", completion };
    const [failure] = sql
      .exec<FailureRow>(
        "SELECT reason, detail, failed_at FROM openrouter_authorization_failures WHERE openrouter_authorization_id = ?",
        openRouterAuthorizationId,
      )
      .toArray();
    if (failure !== undefined) return { state: "Failed", failure };
    throw new Error(`OpenRouter authorization ${openRouterAuthorizationId} has no phase row`);
  }

  private presentOpenRouterAuthorization(tenantId: string, row: AuthorizationRow): OpenRouterAuthorization {
    return OpenRouterAuthorizationSchema.parse({
      openRouterAuthorizationId: row.openrouter_authorization_id,
      tenantId,
      principalId: row.principal_id,
      secretSetId: row.secret_set_id,
      status: statusOf(this.openRouterPhase(row.openrouter_authorization_id), row.key_label),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private endPhase(openRouterAuthorizationId: string, from: LivePhaseTable, now: number): boolean {
    const sql = this.ctx.storage.sql;
    const ended = sql.exec(
      `DELETE FROM ${from} WHERE openrouter_authorization_id = ?`,
      openRouterAuthorizationId,
    ).rowsWritten;
    if (ended === 0) return false;
    sql.exec(
      "UPDATE openrouter_authorizations SET updated_at = ? WHERE openrouter_authorization_id = ?",
      now,
      openRouterAuthorizationId,
    );
    return true;
  }

  private failOpenRouterAuthorization(
    openRouterAuthorizationId: string,
    from: LivePhaseTable,
    reason: OpenRouterAuthorizationFailureReason,
    detail: string,
    now: number,
  ): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (!this.endPhase(openRouterAuthorizationId, from, now)) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO openrouter_authorization_failures (openrouter_authorization_id, reason, detail, failed_at) VALUES (?, ?, ?, ?)",
        openRouterAuthorizationId,
        reason,
        detail,
        now,
      );
      return true;
    });
  }

  private otherOpenRouterCredential(secretSetId: string): string | null {
    const [row] = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM secret_credentials WHERE secret_set_id = ? AND provider = ? AND name != ?",
        secretSetId,
        OPENROUTER_PROVIDER,
        OPENROUTER_MEMBER,
      )
      .toArray();
    return row?.name ?? null;
  }

  protected async startOpenRouterAuthorization(
    tenantId: string,
    principalId: string,
    input: NewOpenRouterAuthorization,
    now: number,
  ): Promise<OpenRouterAuthorizationStarted> {
    const sql = this.ctx.storage.sql;
    const [set] = sql
      .exec<{ name: string }>("SELECT name FROM secret_sets WHERE secret_set_id = ?", input.secretSetId)
      .toArray();
    if (set === undefined) return { kind: "NoSecretSet" };
    const other = this.otherOpenRouterCredential(input.secretSetId);
    if (other !== null) return { kind: "OtherCredential", name: other };
    const openRouterAuthorizationId = crypto.randomUUID();
    const { verifier, challenge } = await pkcePair();
    const state = await signState(await keyStoreOf(this.env).signingKey(STATE_PURPOSE), {
      purpose: "OpenRouterAuthorization",
      tenantId,
      openRouterAuthorizationId,
    });
    const keyLabel = keyLabelOf(set.name);
    const url = authorizeUrl(this.env.OPENROUTER_ORIGIN, {
      callbackUrl: callbackUrl(input.controlPlaneOrigin, state),
      challenge,
      keyLabel,
    });
    const sealed = await seal(await this.dataKey(), verifier, verifierContext(openRouterAuthorizationId));
    const dueAt = now + CALLBACK_BUDGET_SECONDS * 1000;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO openrouter_authorizations (openrouter_authorization_id, principal_id, secret_set_id, key_label,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        openRouterAuthorizationId,
        principalId,
        input.secretSetId,
        keyLabel,
        now,
        now,
      );
      sql.exec(
        `INSERT INTO openrouter_authorization_waits (openrouter_authorization_id, authorize_url, verifier_sealed,
        callback_due_at) VALUES (?, ?, ?, ?)`,
        openRouterAuthorizationId,
        url,
        sealed,
        dueAt,
      );
    });
    const row = this.openRouterRow(openRouterAuthorizationId);
    if (row === null) throw new Error(`OpenRouter authorization ${openRouterAuthorizationId} vanished once written`);
    return { kind: "Started", authorization: this.presentOpenRouterAuthorization(tenantId, row) };
  }

  protected getOpenRouterAuthorization(
    tenantId: string,
    principalId: string,
    openRouterAuthorizationId: string,
  ): OpenRouterAuthorizationRead {
    const row = this.openRouterRow(openRouterAuthorizationId);
    if (row === null || row.principal_id !== principalId) return { kind: "NotFound" };
    this.expireOpenRouterAuthorization(row, Date.now());
    const current = this.openRouterRow(openRouterAuthorizationId);
    if (current === null)
      throw new Error(`OpenRouter authorization ${openRouterAuthorizationId} vanished while it was read`);
    return { kind: "Found", authorization: this.presentOpenRouterAuthorization(tenantId, current) };
  }

  protected async openRouterCallback(
    openRouterAuthorizationId: string,
    callback: Exclude<OpenRouterCallback, { kind: "Invalid" }>,
    now: number,
  ): Promise<OpenRouterCallbackSettled> {
    const row = this.openRouterRow(openRouterAuthorizationId);
    if (row === null) return { kind: "NotFound" };
    const returned = { kind: "Returned", secretSetId: row.secret_set_id } as const;
    const phase = this.openRouterPhase(openRouterAuthorizationId);
    if (phase.state !== "AwaitingCallback") return returned;
    const fail = (from: LivePhaseTable, reason: OpenRouterAuthorizationFailureReason, detail: string) => {
      this.failOpenRouterAuthorization(openRouterAuthorizationId, from, reason, detail, Date.now());
      return returned;
    };
    if (now >= phase.wait.callback_due_at) {
      return fail(WAITS, "AuthorizationTimedOut", timedOutDetail(openRouterAuthorizationId));
    }
    if (callback.kind === "NoCode") return fail(WAITS, "NotConnected", notConnectedDetail());
    const exchangeDueAt = now + EXCHANGE_BUDGET_SECONDS * 1000;
    this.ctx.storage.transactionSync(() => {
      this.endPhase(openRouterAuthorizationId, WAITS, now);
      this.ctx.storage.sql.exec(
        "INSERT INTO openrouter_authorization_exchanges (openrouter_authorization_id, exchange_due_at) VALUES (?, ?)",
        openRouterAuthorizationId,
        exchangeDueAt,
      );
    });
    const exchanged = await this.spendOpenRouterCode(row, phase.wait.verifier_sealed, callback.code);
    if (exchanged.kind === "Refused") return fail(EXCHANGES, "CodeRefused", exchanged.detail);
    if (exchanged.kind === "Failed") return fail(EXCHANGES, "ExchangeFailed", exchanged.detail);
    const exchangedAt = Date.now();
    if (exchangedAt >= exchangeDueAt) {
      this.expireOpenRouterAuthorization(row, exchangedAt);
      return returned;
    }
    const stored = await this.storeOpenRouterKey(row, exchanged.key);
    if (stored.kind === "NotStored") return fail(EXCHANGES, "KeyNotStored", stored.detail);
    return returned;
  }

  private async spendOpenRouterCode(row: AuthorizationRow, verifierSealed: string, code: string) {
    const verifier = await unseal(
      await this.dataKey(),
      verifierSealed,
      verifierContext(row.openrouter_authorization_id),
      CONNECT_AGAIN,
    );
    return exchangeCode(fetcher, this.env.OPENROUTER_ORIGIN, { code, verifier });
  }

  private async storeOpenRouterKey(
    row: AuthorizationRow,
    key: string,
  ): Promise<{ kind: "Stored" } | { kind: "NotStored"; detail: string }> {
    const id = row.openrouter_authorization_id;
    const secretSetId = row.secret_set_id;
    const sealed = await seal(await this.dataKey(), key, sealContext(secretSetId, OPENROUTER_MEMBER));
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const [set] = sql.exec("SELECT 1 FROM secret_sets WHERE secret_set_id = ?", secretSetId).toArray();
      const discarded = `OpenRouter minted the key labelled ${row.key_label} and it was discarded; delete it at https://openrouter.ai/settings/keys`;
      if (set === undefined) {
        return {
          kind: "NotStored",
          detail: `secret set ${secretSetId} was deleted while OpenRouter authorization ${id} ran. ${discarded}, then ${CONNECT_AGAIN} on a secret set that exists`,
        } as const;
      }
      const other = this.otherOpenRouterCredential(secretSetId);
      if (other !== null) {
        return {
          kind: "NotStored",
          detail: `secret set ${secretSetId} took the OpenRouter credential ${other} while OpenRouter authorization ${id} ran. ${discarded}, then remove ${other} and ${CONNECT_AGAIN}`,
        } as const;
      }
      if (!this.endPhase(id, EXCHANGES, now)) {
        throw new Error(
          `OpenRouter authorization ${id} ran past its ${EXCHANGE_BUDGET_SECONDS} s exchange limit and failed before it stored the key. ${discarded}, then ${CONNECT_AGAIN}`,
        );
      }
      sql.exec(
        "INSERT INTO openrouter_authorization_completions (openrouter_authorization_id, completed_at) VALUES (?, ?)",
        id,
        now,
      );
      sql.exec("DELETE FROM secret_values WHERE secret_set_id = ? AND name = ?", secretSetId, OPENROUTER_MEMBER);
      sql.exec(
        "INSERT INTO secret_values (secret_set_id, name, kind, sealed, updated_at) VALUES (?, ?, 'ApiKey', ?, ?)",
        secretSetId,
        OPENROUTER_MEMBER,
        sealed,
        now,
      );
      sql.exec(
        "INSERT INTO secret_credentials (secret_set_id, name, provider) VALUES (?, ?, ?)",
        secretSetId,
        OPENROUTER_MEMBER,
        OPENROUTER_PROVIDER,
      );
      sql.exec("UPDATE secret_sets SET updated_at = ? WHERE secret_set_id = ?", now, secretSetId);
      return { kind: "Stored" } as const;
    });
  }

  private expireOpenRouterAuthorization(row: AuthorizationRow, now: number): void {
    const id = row.openrouter_authorization_id;
    const phase = this.openRouterPhase(id);
    if (phase.state === "AwaitingCallback" && phase.wait.callback_due_at <= now) {
      this.failOpenRouterAuthorization(id, WAITS, "AuthorizationTimedOut", timedOutDetail(id), now);
    }
    if (phase.state === "Exchanging" && phase.exchange.exchange_due_at <= now) {
      this.failOpenRouterAuthorization(id, EXCHANGES, "ExchangeFailed", exchangeStoppedDetail(id, row.key_label), now);
    }
  }

  protected openRouterSecretSets(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>(
        `SELECT secret_sets.name FROM secret_credentials JOIN secret_sets USING (secret_set_id)
        WHERE secret_credentials.provider = ? ORDER BY secret_sets.name`,
        OPENROUTER_PROVIDER,
      )
      .toArray()
      .map((row) => row.name);
  }
}
