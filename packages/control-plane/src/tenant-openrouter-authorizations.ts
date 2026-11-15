import { OpenRouterAuthorizationSchema } from "@tumpel/api/schemas";
import { base64Url } from "./crypto";
import { seal, unseal } from "./envelope.ts";
import type { Fetch } from "./github.ts";
import { keyStoreOf } from "./key-store.ts";
import {
  advanceAuthorization,
  authorizeUrl,
  CALLBACK_BUDGET_SECONDS,
  CONNECT_AGAIN,
  callbackUrl,
  exchangeCode,
  keyLabelOf,
  notConnectedDetail,
  OPENROUTER_MEMBER,
  OPENROUTER_PROVIDER,
  type OpenRouterAuthorization,
  type OpenRouterAuthorizationFailureReason,
  type OpenRouterCallback,
  STATE_PURPOSE,
  signState,
} from "./openrouter-oauth.ts";
import type { OpenRouterAuthorizationDeadline } from "./session-timer";
import { TenantCircleCIAuthorizations } from "./tenant-circleci-authorizations";
import { sealContext } from "./tenant-sessions";

type AuthorizationRow = {
  openrouter_authorization_id: string;
  principal_id: string;
  secret_set_id: string;
  return_url: string;
  key_label: string;
  created_at: number;
  updated_at: number;
};

type WaitRow = { authorize_url: string; verifier_sealed: string; callback_due_at: number };
type CompletionRow = { completed_at: number };
type FailureRow = { reason: string; detail: string; failed_at: number };

type Phase =
  | { state: "AwaitingCallback"; wait: WaitRow }
  | { state: "Completed"; completion: CompletionRow }
  | { state: "Failed"; failure: FailureRow };

export type NewOpenRouterAuthorization = {
  secretSetId: string;
  returnUrl: string;
  controlPlaneOrigin: string;
};

export type OpenRouterAuthorizationStarted =
  | { kind: "Started"; authorization: OpenRouterAuthorization }
  | { kind: "NoSecretSet" }
  | { kind: "OtherCredential"; name: string };

export type OpenRouterAuthorizationRead =
  | { kind: "Found"; authorization: OpenRouterAuthorization }
  | { kind: "NotFound" };

export type OpenRouterCallbackSettled = { kind: "Returned"; returnUrl: string } | { kind: "NotFound" };

const SELECT = `SELECT openrouter_authorization_id, principal_id, secret_set_id, return_url, key_label, created_at, updated_at
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
  if (phase.state === "Completed") {
    return {
      state: "Completed",
      memberName: OPENROUTER_MEMBER,
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

export class TenantOpenRouterAuthorizations extends TenantCircleCIAuthorizations {
  private readonly spending = new Set<string>();

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
      returnUrl: row.return_url,
      status: statusOf(this.openRouterPhase(row.openrouter_authorization_id), row.key_label),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private openRouterTimer(tenantId: string, openRouterAuthorizationId: string, at: number | null): Promise<void> {
    return this.env.SESSION_TIMER.getByName(openRouterAuthorizationId).set(tenantId, {
      OpenRouterAuthorization: at === null ? null : { openRouterAuthorizationId, at },
    });
  }

  private endWait(openRouterAuthorizationId: string, now: number): boolean {
    const sql = this.ctx.storage.sql;
    const ended = sql.exec(
      "DELETE FROM openrouter_authorization_waits WHERE openrouter_authorization_id = ?",
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
    reason: OpenRouterAuthorizationFailureReason,
    detail: string,
    now: number,
  ): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (!this.endWait(openRouterAuthorizationId, now)) return false;
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

  async startOpenRouterAuthorization(
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
    const url = authorizeUrl({ callbackUrl: callbackUrl(input.controlPlaneOrigin, state), challenge, keyLabel });
    const sealed = await seal(await this.dataKey(), verifier, verifierContext(openRouterAuthorizationId));
    const dueAt = now + CALLBACK_BUDGET_SECONDS * 1000;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT INTO openrouter_authorizations (openrouter_authorization_id, principal_id, secret_set_id, return_url,
        key_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        openRouterAuthorizationId,
        principalId,
        input.secretSetId,
        input.returnUrl,
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
    await this.openRouterTimer(tenantId, openRouterAuthorizationId, dueAt);
    const row = this.openRouterRow(openRouterAuthorizationId);
    if (row === null) throw new Error(`OpenRouter authorization ${openRouterAuthorizationId} vanished once written`);
    return { kind: "Started", authorization: this.presentOpenRouterAuthorization(tenantId, row) };
  }

  private async settleDeadline(tenantId: string, row: AuthorizationRow, now: number): Promise<void> {
    const id = row.openrouter_authorization_id;
    const phase = this.openRouterPhase(id);
    if (phase.state !== "AwaitingCallback") return;
    const step = advanceAuthorization(id, phase.state, { kind: "Callback", now, dueAt: phase.wait.callback_due_at });
    if (step.kind !== "Fail") return;
    if (this.failOpenRouterAuthorization(id, step.reason, step.detail, now))
      await this.openRouterTimer(tenantId, id, null);
  }

  async getOpenRouterAuthorization(
    tenantId: string,
    principalId: string,
    openRouterAuthorizationId: string,
    now: number,
  ): Promise<OpenRouterAuthorizationRead> {
    const row = this.openRouterRow(openRouterAuthorizationId);
    if (row === null || row.principal_id !== principalId) return { kind: "NotFound" };
    await this.settleDeadline(tenantId, row, now);
    return { kind: "Found", authorization: this.presentOpenRouterAuthorization(tenantId, row) };
  }

  async openRouterCallback(
    tenantId: string,
    openRouterAuthorizationId: string,
    callback: Exclude<OpenRouterCallback, { kind: "Invalid" }>,
    now: number,
  ): Promise<OpenRouterCallbackSettled> {
    const row = this.openRouterRow(openRouterAuthorizationId);
    if (row === null) return { kind: "NotFound" };
    const returned = { kind: "Returned", returnUrl: row.return_url } as const;
    const phase = this.openRouterPhase(openRouterAuthorizationId);
    if (phase.state !== "AwaitingCallback" || this.spending.has(openRouterAuthorizationId)) return returned;
    const step = advanceAuthorization(openRouterAuthorizationId, phase.state, {
      kind: "Callback",
      now,
      dueAt: phase.wait.callback_due_at,
    });
    const fail = async (reason: OpenRouterAuthorizationFailureReason, detail: string) => {
      if (this.failOpenRouterAuthorization(openRouterAuthorizationId, reason, detail, Date.now())) {
        await this.openRouterTimer(tenantId, openRouterAuthorizationId, null);
      }
      return returned;
    };
    if (step.kind === "Fail") return fail(step.reason, step.detail);
    if (step.kind !== "Proceed") return returned;
    if (callback.kind === "NoCode") return fail("NotConnected", notConnectedDetail());
    this.spending.add(openRouterAuthorizationId);
    const exchanged = await this.spendOpenRouterCode(row, phase.wait.verifier_sealed, callback.code).finally(() =>
      this.spending.delete(openRouterAuthorizationId),
    );
    if (exchanged.kind === "Refused") return fail("CodeRefused", exchanged.detail);
    if (exchanged.kind === "Failed") return fail("ExchangeFailed", exchanged.detail);
    const stored = await this.storeOpenRouterKey(row, exchanged.key);
    if (stored.kind === "NotStored") return fail("KeyNotStored", stored.detail);
    if (stored.kind === "Stored") await this.openRouterTimer(tenantId, openRouterAuthorizationId, null);
    return returned;
  }

  private async spendOpenRouterCode(row: AuthorizationRow, verifierSealed: string, code: string) {
    const verifier = await unseal(
      await this.dataKey(),
      verifierSealed,
      verifierContext(row.openrouter_authorization_id),
      CONNECT_AGAIN,
    );
    return exchangeCode(fetcher, { code, verifier });
  }

  private async storeOpenRouterKey(
    row: AuthorizationRow,
    key: string,
  ): Promise<{ kind: "Stored" } | { kind: "Ended" } | { kind: "NotStored"; detail: string }> {
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
      if (!this.endWait(id, now)) return { kind: "Ended" } as const;
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

  async openRouterAuthorizationDeadlineReached(deadline: OpenRouterAuthorizationDeadline): Promise<void> {
    const id = deadline.openRouterAuthorizationId;
    const phase = this.openRouterRow(id) === null ? null : this.openRouterPhase(id);
    if (phase === null || phase.state !== "AwaitingCallback" || phase.wait.callback_due_at !== deadline.at) return;
    const step = advanceAuthorization(id, phase.state, { kind: "Deadline" });
    if (step.kind !== "Fail") return;
    this.failOpenRouterAuthorization(id, step.reason, step.detail, Date.now());
  }

  openRouterSecretSets(): string[] {
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
