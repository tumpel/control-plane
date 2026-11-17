import type {
  BootImage,
  HostMessage,
  PreparedClaudeSetup,
  StoredClaudeSetupCode,
  StoredClaudeSetupOffer,
} from "./channel/protocol.ts";
import {
  advance,
  type ClaudeSetup,
  type ClaudeSetupEvent,
  type ClaudeSetupFailureReason,
  type ClaudeSetupHarness,
  type ClaudeSetupRow,
  harnessOf,
  overdue,
  SETUP_CREDENTIALS,
  setupOffer,
  stateOf,
  TOKEN_LIFETIME_MS,
  toClaudeSetup,
} from "./claude-setup.ts";
import { base64Url, sameSecret } from "./crypto";
import { seal, unseal } from "./envelope.ts";
import { type HostRecord, hostOf } from "./hosts";
import { keyStoreOf } from "./key-store.ts";
import { placeSession, type Unplaceable } from "./placement";
import { signerOf } from "./presign";
import { bootArchitectures, bootFor, bootImage, readRelease } from "./releases";
import type { ClaudeSetupDeadline } from "./session-timer";
import { settingsOf } from "./settings";
import { TenantPrebuilds } from "./tenant-prebuilds";
import { type HostReply, sealContext, type TenantHostMessage } from "./tenant-sessions";

type ClaudeSetupDiscard = Extract<HostReply, { type: "ClaudeSetupBoxDiscard" }>;

const BOX_TOKEN_PURPOSE = "tumpel-claude-setup-box-token-v1";
const CLAUDE_SETUP_SELECT = `SELECT claude_setup_id, principal_id, secret_set_id, host_id, box_id, harness, harness_version, endpoint, state,
  phase_due_at, sign_in_url, user_code, reason, detail, expires_at, ended_at, created_at, updated_at FROM claude_setups`;

export interface NewClaudeSetup {
  principalId: string;
  secretSetId: string;
  harness: ClaudeSetupHarness;
  harnessVersion: string;
  hosts: HostRecord[];
  endpoint: string;
}

export type ClaudeSetupStarted =
  | { kind: "Started"; setup: ClaudeSetup }
  | { kind: "Unplaced"; hosts: Unplaceable[] }
  | { kind: "ReleaseUnreadable"; detail: string }
  | { kind: "NoSecretSet" }
  | { kind: "OtherCredential"; name: string };

export type ClaudeSetupCoded =
  | { kind: "Coded"; setup: ClaudeSetup }
  | { kind: "NotFound" }
  | { kind: "NotWaiting"; detail: string };

export type ClaudeSetupStored =
  | { kind: "Stored" }
  | { kind: "NotFound" }
  | { kind: "Refused" }
  | { kind: "NotWaiting"; detail: string }
  | { kind: "NotStored"; detail: string };

type TokenWritten =
  | { kind: "Written" }
  | { kind: "NotStored"; detail: string }
  | { kind: "NotWaiting"; detail: string };

type ClaudeSetupHostMessage = Extract<HostMessage, { type: "ClaudeSetupBoxUrl" | "ClaudeSetupBoxFailed" }>;

const isClaudeSetupMessage = (message: HostMessage): message is ClaudeSetupHostMessage =>
  message.type === "ClaudeSetupBoxUrl" || message.type === "ClaudeSetupBoxFailed";

const codeContext = (claudeSetupId: string): string => `claude-setup/${claudeSetupId}/code`;

export class TenantClaudeSetups extends TenantPrebuilds {
  private claudeSetupRow(claudeSetupId: string): ClaudeSetupRow | null {
    const [row] = this.ctx.storage.sql
      .exec<ClaudeSetupRow>(`${CLAUDE_SETUP_SELECT} WHERE claude_setup_id = ?`, claudeSetupId)
      .toArray();
    return row ?? null;
  }

  private async currentClaudeSetupRow(
    tenantId: string,
    claudeSetupId: string,
    now: number,
  ): Promise<ClaudeSetupRow | null> {
    const row = this.claudeSetupRow(claudeSetupId);
    if (row === null || !overdue(row, now)) return row;
    await this.discardClaudeSetupBox(row, await this.stepClaudeSetup(tenantId, row, { kind: "Deadline" }, now));
    return this.claudeSetupRow(claudeSetupId);
  }

  private presentClaudeSetup(tenantId: string, claudeSetupId: string): ClaudeSetup {
    const row = this.claudeSetupRow(claudeSetupId);
    if (row === null) throw new Error(`Claude setup ${claudeSetupId} vanished while it was read back`);
    return toClaudeSetup(tenantId, row);
  }

  private claudeSetupTimer(tenantId: string, claudeSetupId: string, at: number | null): Promise<void> {
    return this.env.SESSION_TIMER.getByName(claudeSetupId).set(tenantId, {
      ClaudeSetup: at === null ? null : { claudeSetupId, at },
    });
  }

  private async boxToken(tenantId: string, claudeSetupId: string): Promise<string> {
    const key = await keyStoreOf(this.env).signingKey(BOX_TOKEN_PURPOSE);
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${tenantId}/${claudeSetupId}`));
    return base64Url(new Uint8Array(signed));
  }

  private otherCredential(secretSetId: string, harness: ClaudeSetupHarness): string | null {
    const { provider, member } = SETUP_CREDENTIALS[harness];
    const [row] = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM secret_credentials WHERE secret_set_id = ? AND provider = ? AND name != ?",
        secretSetId,
        provider,
        member,
      )
      .toArray();
    return row?.name ?? null;
  }

  async startClaudeSetup(tenantId: string, input: NewClaudeSetup, now: number): Promise<ClaudeSetupStarted> {
    const sql = this.ctx.storage.sql;
    const [set] = sql.exec("SELECT 1 FROM secret_sets WHERE secret_set_id = ?", input.secretSetId).toArray();
    if (set === undefined) return { kind: "NoSecretSet" };
    const other = this.otherCredential(input.secretSetId, input.harness);
    if (other !== null) return { kind: "OtherCredential", name: other };
    const release = await readRelease(this.env.RELEASES, now);
    if (release.kind === "Unreadable") return { kind: "ReleaseUnreadable", detail: release.detail };
    const placement = placeSession(input.hosts, this.listHostUsage(tenantId), {
      harness: input.harness,
      harnessVersion: input.harnessVersion,
      architectures: bootArchitectures(release, input.harness, input.harnessVersion),
    });
    if (placement.kind === "Refused") return { kind: "Unplaced", hosts: placement.hosts };
    const settings = settingsOf(this.env);
    const claudeSetupId = crypto.randomUUID();
    const dueAt = now + settings.claudeSetupUrlBudgetSeconds * 1000;
    const running = this.runningClaudeSetupRow(input.secretSetId);
    const superseded =
      running !== null &&
      this.markClaudeSetupFailed(
        running,
        "Superseded",
        `Claude setup ${claudeSetupId} of secret set ${input.secretSetId} started, and a secret set runs one setup at a time; follow Claude setup ${claudeSetupId}`,
        now,
      );
    sql.exec(
      `INSERT INTO claude_setups (claude_setup_id, principal_id, secret_set_id, host_id, box_id, harness, harness_version, endpoint, state, phase_due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Starting', ?, ?, ?)`,
      claudeSetupId,
      input.principalId,
      input.secretSetId,
      placement.host.hostId,
      crypto.randomUUID(),
      input.harness,
      input.harnessVersion,
      input.endpoint,
      dueAt,
      now,
      now,
    );
    const row = this.claudeSetupRow(claudeSetupId);
    if (row === null) throw new Error(`Claude setup ${claudeSetupId} was created and then not found`);
    if (running !== null && superseded) {
      await this.discardClaudeSetupBox(running, await this.endFailedClaudeSetup(tenantId, running, true));
    }
    await this.claudeSetupTimer(tenantId, claudeSetupId, dueAt);
    const offer: StoredClaudeSetupOffer = { type: "ClaudeSetupBoxOffer", claudeSetupId, boxId: row.box_id };
    await this.host(row.host_id).send(offer);
    return { kind: "Started", setup: toClaudeSetup(tenantId, row) };
  }

  async getClaudeSetup(tenantId: string, claudeSetupId: string, now: number): Promise<ClaudeSetup | null> {
    const row = await this.currentClaudeSetupRow(tenantId, claudeSetupId, now);
    return row === null ? null : toClaudeSetup(tenantId, row);
  }

  private runningClaudeSetupRow(secretSetId: string): ClaudeSetupRow | null {
    const [row] = this.ctx.storage.sql
      .exec<ClaudeSetupRow>(
        `${CLAUDE_SETUP_SELECT} WHERE secret_set_id = ? AND state IN ('Starting', 'AwaitingCode', 'Minting')`,
        secretSetId,
      )
      .toArray();
    return row ?? null;
  }

  async listClaudeSetups(tenantId: string, secretSetId: string, now: number): Promise<ClaudeSetup[]> {
    const running = this.runningClaudeSetupRow(secretSetId);
    if (running === null) return [];
    if (!overdue(running, now)) return [toClaudeSetup(tenantId, running)];
    await this.discardClaudeSetupBox(running, await this.stepClaudeSetup(tenantId, running, { kind: "Deadline" }, now));
    return [];
  }

  async submitClaudeSetupCode(
    tenantId: string,
    claudeSetupId: string,
    code: string,
    now: number,
  ): Promise<ClaudeSetupCoded> {
    const row = await this.currentClaudeSetupRow(tenantId, claudeSetupId, now);
    if (row === null) return { kind: "NotFound" };
    const step = advance(claudeSetupId, harnessOf(row), stateOf(row), { kind: "Code" }, settingsOf(this.env));
    if (step.kind === "Refuse") return { kind: "NotWaiting", detail: step.detail };
    if (step.kind !== "Advance") return { kind: "NotWaiting", detail: `Claude setup ${claudeSetupId} takes no code` };
    const sealed = await seal(await this.dataKey(), code, codeContext(claudeSetupId));
    const dueAt = now + step.dueInSeconds * 1000;
    const moved = this.ctx.storage.sql.exec(
      "UPDATE claude_setups SET state = ?, sealed_code = ?, phase_due_at = ?, updated_at = ? WHERE claude_setup_id = ? AND state = 'AwaitingCode'",
      step.state,
      sealed,
      dueAt,
      now,
      claudeSetupId,
    ).rowsWritten;
    if (moved === 0) return { kind: "NotWaiting", detail: `Claude setup ${claudeSetupId} already took a code` };
    await this.claudeSetupTimer(tenantId, claudeSetupId, dueAt);
    const stored: StoredClaudeSetupCode = { type: "ClaudeSetupBoxCode", claudeSetupId, boxId: row.box_id };
    await this.host(row.host_id).send(stored);
    return { kind: "Coded", setup: this.presentClaudeSetup(tenantId, claudeSetupId) };
  }

  async writeClaudeSetupToken(
    tenantId: string,
    claudeSetupId: string,
    credential: string,
    token: string,
    tokenExpiresAt: string | undefined,
    now: number,
  ): Promise<ClaudeSetupStored> {
    if (this.claudeSetupRow(claudeSetupId) === null) return { kind: "NotFound" };
    if (!sameSecret(credential, await this.boxToken(tenantId, claudeSetupId))) return { kind: "Refused" };
    const row = await this.currentClaudeSetupRow(tenantId, claudeSetupId, now);
    if (row === null) return { kind: "NotFound" };
    const harness = harnessOf(row);
    const step = advance(claudeSetupId, harness, stateOf(row), { kind: "Stored" }, settingsOf(this.env));
    if (step.kind !== "Complete") {
      return {
        kind: "NotWaiting",
        detail:
          step.kind === "Refuse" ? step.detail : `Claude setup ${claudeSetupId} is ${row.state} and takes no token`,
      };
    }
    const { secret_set_id: secretSetId, state } = row;
    const { member, provider, kind } = SETUP_CREDENTIALS[harness];
    if (harness === "Codex" && tokenExpiresAt === undefined) {
      const detail = `the box of Claude setup ${claudeSetupId} sent the Codex token without expiresAt; the token was discarded with the box. Update the host's supervisor, then start the Codex sign-in again`;
      await this.failClaudeSetup(tenantId, row, "TokenNotStored", detail, now, false);
      return { kind: "NotStored", detail };
    }
    const sealed = await seal(await this.dataKey(), token, sealContext(secretSetId, member));
    const expiresAt =
      harness === "Codex" && tokenExpiresAt !== undefined
        ? new Date(tokenExpiresAt).toISOString()
        : new Date(now + TOKEN_LIFETIME_MS).toISOString();
    const sql = this.ctx.storage.sql;
    const written = this.ctx.storage.transactionSync((): TokenWritten => {
      const [set] = sql.exec("SELECT 1 FROM secret_sets WHERE secret_set_id = ?", secretSetId).toArray();
      if (set === undefined) {
        return {
          kind: "NotStored",
          detail: `secret set ${secretSetId} was deleted while Claude setup ${claudeSetupId} ran`,
        };
      }
      const other = this.otherCredential(secretSetId, harness);
      if (other !== null) {
        return {
          kind: "NotStored",
          detail: `secret set ${secretSetId} took the ${provider} credential ${other} while Claude setup ${claudeSetupId} ran`,
        };
      }
      const completed = sql.exec(
        `UPDATE claude_setups SET state = 'Completed', expires_at = ?, sealed_code = NULL, ended_at = ?, updated_at = ?
        WHERE claude_setup_id = ? AND state = ?`,
        expiresAt,
        now,
        now,
        claudeSetupId,
        state,
      ).rowsWritten;
      if (completed === 0) {
        return {
          kind: "NotWaiting",
          detail: `Claude setup ${claudeSetupId} ended while its token was sealed and takes no token`,
        };
      }
      this.replaceCredentialMember(secretSetId, { kind, name: member, provider }, sealed, expiresAt, now);
      return { kind: "Written" };
    });
    if (written.kind === "NotWaiting") return written;
    if (written.kind === "NotStored") {
      const detail = `${written.detail}; the minted token was discarded with the box. Fix the secret set, then start the ${SETUP_CREDENTIALS[harness].name} setup again`;
      await this.failClaudeSetup(tenantId, row, "TokenNotStored", detail, now, false);
      return { kind: "NotStored", detail };
    }
    await this.claudeSetupTimer(tenantId, claudeSetupId, null);
    return { kind: "Stored" };
  }

  private async failClaudeSetup(
    tenantId: string,
    row: ClaudeSetupRow,
    reason: ClaudeSetupFailureReason,
    detail: string,
    now: number,
    discard: boolean,
  ): Promise<ClaudeSetupDiscard | null> {
    if (!this.markClaudeSetupFailed(row, reason, detail, now)) return null;
    return this.endFailedClaudeSetup(tenantId, row, discard);
  }

  private markClaudeSetupFailed(
    row: ClaudeSetupRow,
    reason: ClaudeSetupFailureReason,
    detail: string,
    now: number,
  ): boolean {
    return (
      this.ctx.storage.sql.exec(
        `UPDATE claude_setups SET state = 'Failed', reason = ?, detail = ?, sealed_code = NULL, ended_at = ?, updated_at = ?
        WHERE claude_setup_id = ? AND state IN ('Starting', 'AwaitingCode', 'Minting')`,
        reason,
        detail,
        now,
        now,
        row.claude_setup_id,
      ).rowsWritten > 0
    );
  }

  private async endFailedClaudeSetup(
    tenantId: string,
    row: ClaudeSetupRow,
    discard: boolean,
  ): Promise<ClaudeSetupDiscard | null> {
    await this.claudeSetupTimer(tenantId, row.claude_setup_id, null);
    if (!discard) return null;
    return { type: "ClaudeSetupBoxDiscard", claudeSetupId: row.claude_setup_id, boxId: row.box_id };
  }

  private async discardClaudeSetupBox(row: ClaudeSetupRow, discard: ClaudeSetupDiscard | null): Promise<void> {
    if (discard !== null) await this.host(row.host_id).send(discard);
  }

  private async stepClaudeSetup(
    tenantId: string,
    row: ClaudeSetupRow,
    event: ClaudeSetupEvent,
    now: number,
  ): Promise<ClaudeSetupDiscard | null> {
    const step = advance(row.claude_setup_id, harnessOf(row), stateOf(row), event, settingsOf(this.env));
    if (step.kind === "Fail") {
      return this.failClaudeSetup(tenantId, row, step.reason, step.detail, now, event.kind !== "BoxFailed");
    }
    if (step.kind !== "Advance" || event.kind !== "Url") return null;
    const dueAt = now + step.dueInSeconds * 1000;
    this.ctx.storage.sql.exec(
      "UPDATE claude_setups SET state = ?, sign_in_url = ?, user_code = ?, phase_due_at = ?, updated_at = ? WHERE claude_setup_id = ? AND state = 'Starting'",
      step.state,
      event.signInUrl,
      event.userCode,
      dueAt,
      now,
      row.claude_setup_id,
    );
    await this.claudeSetupTimer(tenantId, row.claude_setup_id, dueAt);
    return null;
  }

  override async hostMessage(tenantId: string, hostId: string, message: TenantHostMessage): Promise<HostReply | null> {
    if (!isClaudeSetupMessage(message)) return super.hostMessage(tenantId, hostId, message);
    const row = this.claudeSetupRow(message.claudeSetupId);
    if (row === null || row.host_id !== hostId) {
      throw new Error(
        `host ${hostId} sent ${message.type} for Claude setup ${message.claudeSetupId}, which tenant ${tenantId} did not offer it`,
      );
    }
    const event: ClaudeSetupEvent =
      message.type === "ClaudeSetupBoxUrl"
        ? { kind: "Url", signInUrl: message.signInUrl, userCode: message.userCode ?? null }
        : { kind: "BoxFailed", reason: message.reason, detail: message.detail };
    return this.stepClaudeSetup(tenantId, row, event, Date.now());
  }

  async claudeSetupDeadlineReached(tenantId: string, deadline: ClaudeSetupDeadline): Promise<void> {
    const row = this.claudeSetupRow(deadline.claudeSetupId);
    if (row === null || row.phase_due_at !== deadline.at) return;
    await this.discardClaudeSetupBox(row, await this.stepClaudeSetup(tenantId, row, { kind: "Deadline" }, Date.now()));
  }

  private async claudeSetupImage(
    tenantId: string,
    row: ClaudeSetupRow,
    hostId: string,
    now: number,
  ): Promise<BootImage | string> {
    const host = await hostOf(this.env.DB, tenantId, hostId);
    if (host === null)
      throw new Error(
        `Claude setup ${row.claude_setup_id} is offered to host ${hostId}, which tenant ${tenantId} does not list`,
      );
    const release = await readRelease(this.env.RELEASES, now);
    if (release.kind === "Unreadable") {
      return `the published release is unreadable: ${release.detail}; ask the operator to publish a release with the release workflow, then start the Claude setup again`;
    }
    const boot = bootFor(release, row.harness, row.harness_version, host.architecture);
    if (boot === undefined) {
      return `the current release carries no ${row.harness} ${row.harness_version} guest image for ${host.architecture}, the architecture of host ${host.name} (${hostId}); pin a harness version the current release carries, then start the Claude setup again`;
    }
    const signer = signerOf(
      this.env,
      this.env.RELEASES_BUCKET_NAME,
      this.env.RELEASES_ACCESS_KEY_ID,
      this.env.RELEASES_SECRET_ACCESS_KEY,
    );
    const seconds = settingsOf(this.env).claudeSetupUrlBudgetSeconds;
    return bootImage(signer, boot, seconds, seconds, now);
  }

  async prepareClaudeSetup(
    tenantId: string,
    stored: StoredClaudeSetupOffer | StoredClaudeSetupCode,
    hostId: string,
    now: number,
  ): Promise<PreparedClaudeSetup> {
    const row = this.claudeSetupRow(stored.claudeSetupId);
    if (row === null || row.host_id !== hostId) {
      throw new Error(
        `host ${hostId} has a ${stored.type} for Claude setup ${stored.claudeSetupId}, which tenant ${tenantId} did not offer it`,
      );
    }
    const withdrawn: PreparedClaudeSetup = {
      kind: "Withdrawn",
      message: { type: "ClaudeSetupBoxDiscard", claudeSetupId: row.claude_setup_id, boxId: row.box_id },
    };
    const live = row.state === "Starting" || row.state === "AwaitingCode" || row.state === "Minting";
    if (!live) return withdrawn;
    if (stored.type === "ClaudeSetupBoxCode") {
      const [sealed] = this.ctx.storage.sql
        .exec<{ sealed_code: string | null }>(
          "SELECT sealed_code FROM claude_setups WHERE claude_setup_id = ?",
          row.claude_setup_id,
        )
        .toArray();
      if (sealed?.sealed_code == null) return withdrawn;
      const code = await unseal(await this.dataKey(), sealed.sealed_code, codeContext(row.claude_setup_id));
      return {
        kind: "Ready",
        message: {
          type: "ClaudeSetupBoxCode",
          claudeSetupId: row.claude_setup_id,
          boxId: row.box_id,
          code,
          mintBudgetSeconds: settingsOf(this.env).claudeSetupMintBudgetSeconds,
        },
      };
    }
    const image = await this.claudeSetupImage(tenantId, row, hostId, now);
    if (typeof image === "string") {
      await this.failClaudeSetup(tenantId, row, "SetupUrlMissing", image, now, false);
      return withdrawn;
    }
    const token = await this.boxToken(tenantId, row.claude_setup_id);
    return { kind: "Ready", message: setupOffer(tenantId, row, image, token, settingsOf(this.env)) };
  }
}
