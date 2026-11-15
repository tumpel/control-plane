import { DurableObject } from "cloudflare:workers";
import {
  CredentialHandoverSchema,
  SecretSetCreateSchema,
  SecretSetSchema,
  type SessionIssueSchema,
  SessionSchema,
  type SessionStartSchema,
  SnapshotSchema,
  type StartedSessionFromIssueSchema,
  type StartedSessionSchema,
  StopFailureSchema,
  TranscriptLineSchema,
  TurnFailureSchema,
  TurnSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import {
  type GuestImageDownload,
  HEARTBEAT_DEADLINE_MS,
  type HostMessage,
  type HostUsage,
  type PersonaFileDownload,
  type PreparedOffer,
  type SnapshotDownload,
  type StoredControlMessage,
} from "./channel/protocol.ts";
import {
  type CredentialRefusal,
  checkCredential,
  dispatchVariables,
  type SecretKey,
  type SecretMember,
} from "./dispatch-variables.ts";
import { generateDataKey, unseal } from "./envelope.ts";
import {
  botLogin,
  botUserId,
  type CommitIdentity,
  commitIdentity,
  type GitHubRepository,
  githubRepository,
  type Minted,
  mintInstallationToken,
  REPOSITORY_TOKEN,
  type RepositoryCredentialSource,
  repositoryCredential,
} from "./github.ts";
import { appKey, installationsOf, storeBotUserId, storedApp } from "./github-store.ts";
import { catalogEntry } from "./harness-catalog";
import { type Host, hostOf } from "./hosts";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import { personaFileKey } from "./persona-files";
import { type ImageAvailability, placeSession, type ReportedHostUsage, type Unplaceable } from "./placement";
import { signerOf } from "./presign";
import { currentRelease, imageKey, imagesFor, kernelKey, manifestKey } from "./releases";
import type { DeadlineChanges, SessionDueDeadline } from "./session-timer";
import { settingsOf, turnCredentialSeconds } from "./settings";
import { chunkKey, encodeChunk, linesWithin, type Range, rangeAfter, type TranscriptLine } from "./transcript";

export type Session = z.infer<typeof SessionSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type TurnFailure = z.infer<typeof TurnFailureSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type CredentialHandover = z.infer<typeof CredentialHandoverSchema>;
export type SessionStart = z.infer<typeof SessionStartSchema>;
export type StartedSession = z.infer<typeof StartedSessionSchema>;
export type StartedSessionFromIssue = z.infer<typeof StartedSessionFromIssueSchema>;
export type SessionIssue = z.infer<typeof SessionIssueSchema>;
export type IssueOfSession = Omit<SessionIssue, "sessionId">;
type TurnFailureReason = TurnFailure["reason"];
type SessionState = Session["state"];
export type StopFailure = z.infer<typeof StopFailureSchema>;
type IdentityAnswer = { kind: "Identity"; identity: CommitIdentity } | { kind: "Refused"; detail: string };

export interface NewSession {
  principalId: string;
  hosts: Host[];
  harness: Session["harness"];
  harnessVersion: string;
  endpoint: string;
  start: SessionStart;
}

export interface SessionFilter {
  state?: SessionState;
  hostId?: string;
}

export type Started<T> = { kind: "Started"; started: T } | { kind: "Unplaced"; hosts: Unplaceable[] };

export type Sent =
  | { kind: "Sent"; turn: Turn }
  | { kind: "Stranded"; missingTurnIds: string[] }
  | { kind: "Unplaced"; hosts: Unplaceable[] }
  | { kind: "NotFound" }
  | { kind: "InFlight"; turnId: string }
  | { kind: "Stopping" }
  | { kind: "Archived" }
  | { kind: "CredentialRefused"; personaId: string; refusal: CredentialRefusal };

export type Stop =
  | { kind: "Stopping"; session: Session }
  | { kind: "NotFound" }
  | { kind: "InFlight"; turnId: string }
  | { kind: "Archived" };

export type Archive =
  | { kind: "Archived"; session: Session }
  | { kind: "NotFound" }
  | { kind: "NotStopped"; state: SessionState };

export type TranscriptCursor = {
  sessionState: SessionState;
  harness: Session["harness"];
  lastLineSeq: number;
  inFlight: boolean;
} & ({ kind: "Chunk"; storageKey: string; range: Range } | { kind: "Lines"; lines: TranscriptLine[] });

type SessionRow = {
  session_id: string;
  principal_id: string;
  host_id: string;
  box_id: string;
  persona_id: string;
  repository: string;
  harness: string;
  harness_version: string;
  model: string;
  state: string;
  last_line_seq: number;
  endpoint: string;
  created_at: number;
  updated_at: number;
};

type SessionViewRow = SessionRow & {
  last_turn_id: string;
  last_turn_state: string;
  last_turn_at: number;
};

type TurnRow = {
  turn_id: string;
  session_id: string;
  host_id: string;
  box_id: string;
  prompt: string;
  state: string;
  line_count: number;
  created_at: number;
  updated_at: number;
};

type FailureRow = {
  turn_id: string;
  session_id: string;
  reason: string;
  detail: string;
  failed_at: string;
  created_at: number;
};

type HandoverRow = {
  credential_handover_id: string;
  session_id: string;
  turn_id: string;
  host_id: string;
  box_id: string;
  variable_names: string;
  repository_credential_source: string;
  created_at: number;
};

type StopFailureRow = {
  stop_failure_id: string;
  session_id: string;
  reason: string;
  detail: string;
  failed_at: string;
  created_at: number;
};

type PendingRow = {
  session_id: string;
  line_seq: number;
  turn_id: string;
  text: string;
  created_at: number;
};

type ChunkRow = {
  storage_key: string;
  line_seqs: string;
  offsets: string;
};

type SnapshotRow = {
  snapshot_id: string;
  session_id: string;
  box_id: string;
  turn_id: string;
  snapshot_seq: number;
  storage_key: string;
  size_bytes: number | null;
  reason: string | null;
  detail: string | null;
  failed_at: string | null;
  created_at: number;
  updated_at: number;
};

type HostUsageRow = {
  host_id: string;
  box_capacity: number;
  boxes_warm: number;
  load_average: number;
  memory_available_mib: number;
  created_at: number;
  updated_at: number;
};

type SnapshotRequestRow = {
  snapshot_id: string;
  session_id: string;
  box_id: string;
  turn_id: string;
  snapshot_seq: number;
  storage_key: string;
};

const SESSION_SELECT =
  "SELECT session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at FROM sessions";
const SESSION_VIEW_SELECT = `SELECT s.session_id, s.principal_id, s.host_id, s.box_id, s.persona_id, s.repository, s.harness, s.harness_version, s.model, s.state, s.last_line_seq, s.endpoint, s.created_at, s.updated_at,
  t.turn_id AS last_turn_id, t.state AS last_turn_state, t.updated_at AS last_turn_at
  FROM sessions AS s
  JOIN turns AS t ON t.turn_id = (SELECT turn_id FROM turns WHERE session_id = s.session_id ORDER BY created_at DESC, turn_id DESC LIMIT 1)`;
const TURN_SELECT =
  "SELECT turn_id, session_id, host_id, box_id, prompt, state, line_count, created_at, updated_at FROM turns";
const SNAPSHOT_SELECT = `SELECT * FROM (
  SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, NULL AS reason, NULL AS detail, NULL AS failed_at, created_at, updated_at FROM snapshots
  UNION ALL
  SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, NULL, reason, detail, failed_at, created_at, created_at FROM snapshot_failures
)`;

const IN_FLIGHT = ["Offered", "Running"];
const STORE_DELETE_BATCH = 1000;

export type SessionHostMessage = Exclude<HostMessage, { type: "ClaudeSetupBoxUrl" | "ClaudeSetupBoxFailed" }>;
type ChunkAsk = Extract<SessionHostMessage, { type: "SnapshotChunks" | "SnapshotPacks" | "RestoreChunks" }>;
type HostEvent = Exclude<SessionHostMessage, ChunkAsk>;
export type ChunkReply = Extract<
  StoredControlMessage,
  { type: "SnapshotChunksHeld" | "SnapshotPackUploads" | "RestoreDownloads" }
>;

const packKey = (tenantId: string, packDigest: string): string => `${tenantId}/packs/${packDigest}`;

const DEAD_PACKS = "FROM packs WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE chunks.pack_digest = packs.pack_digest)";

const ORPHAN_CHUNKS = `SELECT digest FROM session_chunks AS own WHERE own.session_id = ?1
  AND NOT EXISTS (SELECT 1 FROM session_chunks AS other WHERE other.digest = own.digest AND other.session_id != ?1)`;

const toSession = (tenantId: string, row: SessionViewRow): Session =>
  SessionSchema.parse({
    sessionId: row.session_id,
    tenantId,
    principalId: row.principal_id,
    hostId: row.host_id,
    boxId: row.box_id,
    personaId: row.persona_id,
    repository: row.repository,
    harness: row.harness,
    harnessVersion: row.harness_version,
    model: row.model,
    state: row.state,
    lastTurnId: row.last_turn_id,
    lastTurnState: row.last_turn_state,
    lastTurnAt: new Date(row.last_turn_at).toISOString(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const toTurn = (tenantId: string, row: TurnRow): Turn =>
  TurnSchema.parse({
    turnId: row.turn_id,
    tenantId,
    sessionId: row.session_id,
    boxId: row.box_id,
    prompt: row.prompt,
    state: row.state,
    lineCount: row.line_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const toSnapshot = (tenantId: string, row: SnapshotRow): Snapshot =>
  SnapshotSchema.parse({
    snapshotId: row.snapshot_id,
    tenantId,
    sessionId: row.session_id,
    boxId: row.box_id,
    turnId: row.turn_id,
    snapshotSeq: row.snapshot_seq,
    storageKey: row.storage_key,
    outcome:
      row.size_bytes === null
        ? { state: "Failed", reason: row.reason, detail: row.detail, failedAt: row.failed_at }
        : { state: "Stored", uploadedBytes: row.size_bytes },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const toHandover = (tenantId: string, row: HandoverRow): CredentialHandover =>
  CredentialHandoverSchema.parse({
    credentialHandoverId: row.credential_handover_id,
    tenantId,
    sessionId: row.session_id,
    turnId: row.turn_id,
    hostId: row.host_id,
    boxId: row.box_id,
    variableNames: JSON.parse(row.variable_names),
    repositoryCredentialSource: row.repository_credential_source,
    createdAt: row.created_at,
  });

const toLine = (tenantId: string, row: PendingRow): TranscriptLine =>
  TranscriptLineSchema.parse({
    sessionId: row.session_id,
    lineSeq: row.line_seq,
    tenantId,
    turnId: row.turn_id,
    text: row.text,
    createdAt: row.created_at,
  });

const iso = (at: number): string => new Date(at).toISOString();

export type MemberRow = {
  name: string;
  kind: string;
  sealed: string;
  updated_at: number;
  provider: string | null;
  expires_at: string | null;
};

export const memberRows = (sql: SqlStorage, secretSetId: string): MemberRow[] =>
  sql
    .exec<MemberRow>(
      `SELECT secret_values.name, secret_values.kind, secret_values.sealed, secret_values.updated_at,
        secret_credentials.provider, secret_expiries.expires_at
      FROM secret_values
      LEFT JOIN secret_credentials USING (secret_set_id, name)
      LEFT JOIN secret_expiries USING (secret_set_id, name)
      WHERE secret_values.secret_set_id = ? ORDER BY secret_values.name`,
      secretSetId,
    )
    .toArray();

const memberShape = (row: MemberRow): Record<string, unknown> =>
  row.kind === "Variable"
    ? { kind: row.kind, name: row.name }
    : row.kind === "ApiKey"
      ? { kind: row.kind, name: row.name, provider: row.provider }
      : { kind: row.kind, name: row.name, provider: row.provider, expiresAt: row.expires_at };

export const toKey = (row: MemberRow): SecretKey =>
  SecretSetSchema.shape.keys.element.parse({ ...memberShape(row), updatedAt: row.updated_at });

const toMember = (row: MemberRow, value: string): SecretMember =>
  SecretSetCreateSchema.shape.secrets.element.parse({ ...memberShape(row), value });

export const sealContext = (secretSetId: string, name: string): string => `${secretSetId}/${name}`;

export class TenantSessions extends DurableObject<Env> {
  private sessionRow(sessionId: string): SessionRow | null {
    const [row] = this.ctx.storage.sql.exec<SessionRow>(`${SESSION_SELECT} WHERE session_id = ?`, sessionId).toArray();
    return row ?? null;
  }

  private presentSession(tenantId: string, sessionId: string): Session {
    const session = this.getSession(tenantId, sessionId);
    if (session === null) throw new Error(`session ${sessionId} vanished while it was read back`);
    return session;
  }

  private turnRow(turnId: string): TurnRow | null {
    const [row] = this.ctx.storage.sql.exec<TurnRow>(`${TURN_SELECT} WHERE turn_id = ?`, turnId).toArray();
    return row ?? null;
  }

  private inFlightTurn(sessionId: string): string | null {
    const [running] = this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        `SELECT turn_id FROM turns WHERE session_id = ? AND state IN (${IN_FLIGHT.map(() => "?").join(", ")})`,
        sessionId,
        ...IN_FLIGHT,
      )
      .toArray();
    return running?.turn_id ?? null;
  }

  private latestTurn(sessionId: string, state: string | null): TurnRow | null {
    const [row] = this.ctx.storage.sql
      .exec<TurnRow>(
        `${TURN_SELECT} WHERE session_id = ?1 AND (?2 IS NULL OR state = ?2) ORDER BY created_at DESC, turn_id DESC LIMIT 1`,
        sessionId,
        state,
      )
      .toArray();
    return row ?? null;
  }

  private setSessionState(sessionId: string, state: SessionState, now: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE sessions SET state = ?, updated_at = ? WHERE session_id = ?",
      state,
      now,
      sessionId,
    );
  }

  protected personaRow(personaId: string): { secretSetId: string } | null {
    const [row] = this.ctx.storage.sql
      .exec<{ secret_set_id: string }>("SELECT secret_set_id FROM personas WHERE persona_id = ?", personaId)
      .toArray();
    return row === undefined ? null : { secretSetId: row.secret_set_id };
  }

  private secretSetName(session: SessionRow): string {
    const [row] = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT s.name FROM personas p JOIN secret_sets s ON s.secret_set_id = p.secret_set_id WHERE p.persona_id = ?",
        session.persona_id,
      )
      .toArray();
    if (row === undefined) {
      throw new Error(`persona ${session.persona_id} of session ${session.session_id} runs on no secret set`);
    }
    return row.name;
  }

  private cloneFailureDetail(session: SessionRow, hostDetail: string): string {
    return `${hostDetail}. The persona runs on secret set ${this.secretSetName(session)}`;
  }

  private refusedSetDetail(session: SessionRow, hostDetail: string): string {
    const name = this.secretSetName(session);
    return `${hostDetail}. The credential comes from secret set ${name}; replace its value with tumpel config apply, then send the turn again`;
  }

  private refusedCredential(session: SessionRow, now: number): CredentialRefusal | null {
    const entry = catalogEntry(session.harness, session.harness_version);
    if (entry === undefined) throw new Error(`${session.harness} ${session.harness_version} left the harness catalog`);
    const persona = this.personaRow(session.persona_id);
    if (persona === null) {
      throw new Error(`session ${session.session_id} runs on persona ${session.persona_id}, which is gone`);
    }
    const checked = checkCredential(entry, memberRows(this.ctx.storage.sql, persona.secretSetId).map(toKey), now);
    return checked.kind === "Usable" ? null : checked;
  }

  private wrappedDataKey(): string | null {
    const [row] = this.ctx.storage.sql.exec<{ wrapped: string }>("SELECT wrapped FROM data_keys").toArray();
    return row?.wrapped ?? null;
  }

  protected async holdDataKey(): Promise<void> {
    if (this.wrappedDataKey() !== null) return;
    const wrapped = await keyStoreOf(this.env).wrap(await generateDataKey());
    this.ctx.storage.sql.exec(
      "INSERT INTO data_keys (data_key_id, wrapped, created_at) VALUES (1, ?, ?)",
      wrapped,
      Date.now(),
    );
  }

  protected dataKey(): Promise<CryptoKey> {
    const wrapped = this.wrappedDataKey();
    if (wrapped === null)
      throw new Error("the tenant holds no data key; the Durable Object constructor creates it before any request");
    return keyStoreOf(this.env).unwrap(wrapped);
  }

  protected async members(secretSetId: string): Promise<SecretMember[]> {
    const rows = memberRows(this.ctx.storage.sql, secretSetId);
    if (rows.length === 0) return [];
    const dataKey = await this.dataKey();
    const members: SecretMember[] = [];
    for (const row of rows) {
      const value = await unseal(dataKey, row.sealed, sealContext(secretSetId, row.name));
      members.push(toMember(row, value));
    }
    return members;
  }

  protected async repositoryToken(tenantId: string, repository: GitHubRepository, now: number): Promise<Minted> {
    const installations = await installationsOf(this.env.DB, tenantId);
    if (installations.length === 0) return { kind: "NoToken" };
    const app = await appKey(this.env.DB, keyStoreOf(this.env));
    if (app === null) {
      throw new Error(
        `tenant ${tenantId} holds GitHub installations ${installations.map((installation) => installation.installationId).join(", ")}, and the stage holds no GitHub App; create it again at /github/app/setup and install it with tumpel github start`,
      );
    }
    return mintInstallationToken(
      (url, init) => fetch(url, init),
      this.env.GITHUB_API_ORIGIN,
      app,
      installations,
      repository,
      now,
    );
  }

  private async botIdentity(token: string): Promise<IdentityAnswer> {
    const app = await storedApp(this.env.DB);
    if (app === null) {
      return {
        kind: "Refused",
        detail:
          "the stage's GitHub App was removed after it minted the repository token; create it again at /github/app/setup, install it with tumpel github start, then send the turn again",
      };
    }
    const login = botLogin(app.slug);
    if (app.botUserId !== null) {
      return { kind: "Identity", identity: commitIdentity({ githubUserId: app.botUserId, login }) };
    }
    const read = await botUserId((url, init) => fetch(url, init), this.env.GITHUB_API_ORIGIN, app.slug, token);
    if (!read.ok) {
      return {
        kind: "Refused",
        detail: `${read.detail}; the box commits as ${login}, whose GitHub user id the control plane reads once from GitHub, so send the turn again`,
      };
    }
    await storeBotUserId(this.env.DB, read.value);
    return { kind: "Identity", identity: commitIdentity({ githubUserId: read.value, login }) };
  }

  private async commitIdentityOf(
    minted: Minted,
    source: RepositoryCredentialSource,
    secretSetId: string,
    turnId: string,
  ): Promise<IdentityAnswer> {
    if (minted.kind === "Minted") return this.botIdentity(minted.token);
    if (source === "None") {
      return {
        kind: "Refused",
        detail: `turn ${turnId} has no GitHub credential to clone, commit and push with: no GitHub App installation of the tenant covers its repository and secret set ${secretSetId} holds no ${REPOSITORY_TOKEN}; install the GitHub App with tumpel github start, or add a Variable member ${REPOSITORY_TOKEN} with tumpel config apply, then send the turn again`,
      };
    }
    const [user] = this.ctx.storage.sql
      .exec<{ github_user_id: number; login: string }>(
        "SELECT github_user_id, login FROM secret_set_github_users WHERE secret_set_id = ?",
        secretSetId,
      )
      .toArray();
    if (user === undefined) {
      return {
        kind: "Refused",
        detail: `secret set ${secretSetId} holds a ${REPOSITORY_TOKEN} written before the control plane read its GitHub user; write it again with tumpel config apply, then send the turn again`,
      };
    }
    return { kind: "Identity", identity: commitIdentity({ githubUserId: user.github_user_id, login: user.login }) };
  }

  private timers(tenantId: string, sessionId: string, changes: DeadlineChanges): Promise<void> {
    return this.env.SESSION_TIMER.getByName(sessionId).set(tenantId, sessionId, changes);
  }

  protected host(hostId: string) {
    return this.env.HOST.get(this.env.HOST.idFromName(hostId));
  }

  private async offer(tenantId: string, session: SessionRow, turn: TurnRow): Promise<void> {
    const settings = settingsOf(this.env);
    const now = Date.now();
    await this.timers(tenantId, session.session_id, {
      Claim: { turnId: turn.turn_id, at: now + settings.turnClaimBudgetSeconds * 1000 },
      ImageFetch: null,
      FirstLine: null,
      Total: { turnId: turn.turn_id, at: now + settings.turnTotalBudgetSeconds * 1000 },
      Snapshot: null,
      HostOffline: null,
    });
    const offer: StoredControlMessage = {
      type: "TurnOffer",
      turnId: turn.turn_id,
      sessionId: session.session_id,
      boxId: session.box_id,
      repository: session.repository,
      harness: SessionSchema.shape.harness.parse(session.harness),
      harnessVersion: session.harness_version,
      model: session.model,
      prompt: turn.prompt,
    };
    await this.host(session.host_id).send(offer);
  }

  private insertTurn(sessionId: string, hostId: string, boxId: string, prompt: string, now: number): TurnRow {
    const turn: TurnRow = {
      turn_id: crypto.randomUUID(),
      session_id: sessionId,
      host_id: hostId,
      box_id: boxId,
      prompt,
      state: "Offered",
      line_count: 0,
      created_at: now,
      updated_at: now,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO turns (turn_id, session_id, host_id, box_id, prompt, state, line_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      turn.turn_id,
      turn.session_id,
      turn.host_id,
      turn.box_id,
      turn.prompt,
      turn.state,
      turn.line_count,
      turn.created_at,
      turn.updated_at,
    );
    return turn;
  }

  hostHello(hostId: string, boxCapacity: number, usage: HostUsage, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO host_usage (host_id, box_capacity, boxes_warm, load_average, memory_available_mib, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (host_id) DO UPDATE SET box_capacity = excluded.box_capacity, boxes_warm = excluded.boxes_warm,
        load_average = excluded.load_average, memory_available_mib = excluded.memory_available_mib, updated_at = excluded.updated_at`,
      hostId,
      boxCapacity,
      usage.boxesWarm,
      usage.loadAverage,
      usage.memoryAvailableMib,
      now,
      now,
    );
  }

  hostUsage(hostId: string, usage: HostUsage, now: number): void {
    const updated = this.ctx.storage.sql.exec(
      "UPDATE host_usage SET boxes_warm = ?, load_average = ?, memory_available_mib = ?, updated_at = ? WHERE host_id = ?",
      usage.boxesWarm,
      usage.loadAverage,
      usage.memoryAvailableMib,
      now,
      hostId,
    );
    if (updated.rowsWritten === 0) {
      throw new Error(`host ${hostId} sent a Heartbeat, but its tenant holds no usage from its Hello`);
    }
  }

  forgetHostUsage(hostId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM host_usage WHERE host_id = ?", hostId);
  }

  listHostUsage(tenantId: string): ReportedHostUsage[] {
    const sql = this.ctx.storage.sql;
    const running = new Map(
      sql
        .exec<{ host_id: string; running: number }>(
          `SELECT host_id, COUNT(*) AS running FROM turns WHERE state IN (${IN_FLIGHT.map(() => "?").join(", ")}) GROUP BY host_id`,
          ...IN_FLIGHT,
        )
        .toArray()
        .map((row) => [row.host_id, row.running]),
    );
    return sql
      .exec<HostUsageRow>(
        "SELECT host_id, box_capacity, boxes_warm, load_average, memory_available_mib, created_at, updated_at FROM host_usage ORDER BY created_at, host_id",
      )
      .toArray()
      .map((row) => ({
        hostId: row.host_id,
        tenantId,
        boxCapacity: row.box_capacity,
        boxesRunning: running.get(row.host_id) ?? 0,
        boxesWarm: row.boxes_warm,
        loadAverage: row.load_average,
        memoryAvailableMib: row.memory_available_mib,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  private unsnapshottedTurns(sessionId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        `WITH latest AS (
          SELECT turns.created_at, turns.turn_id FROM snapshots JOIN turns USING (turn_id)
          WHERE snapshots.session_id = ?1 ORDER BY turns.created_at DESC, turns.turn_id DESC LIMIT 1
        )
        SELECT turn_id FROM turns WHERE session_id = ?1 AND state = 'Completed'
          AND NOT EXISTS (SELECT 1 FROM latest WHERE (latest.created_at, latest.turn_id) >= (turns.created_at, turns.turn_id))
        ORDER BY created_at, turn_id`,
        sessionId,
      )
      .toArray()
      .map((row) => row.turn_id);
  }

  private settleSnapshotRequests(session: SessionRow, hostId: string, failedAt: string): void {
    const requests = this.ctx.storage.sql
      .exec<SnapshotRequestRow>(
        "SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key FROM snapshot_requests WHERE session_id = ?",
        session.session_id,
      )
      .toArray();
    for (const request of requests) {
      this.recordSnapshotFailure(
        request,
        "NotAnswered",
        `host ${session.host_id} went offline before it answered snapshot ${request.snapshot_id}, and session ${session.session_id} moved to host ${hostId}`,
        failedAt,
      );
      this.dropPlacements(request.snapshot_id);
    }
  }

  private async imageAvailability(harness: string, harnessVersion: string, now: number): Promise<ImageAvailability> {
    const release = await currentRelease(this.env.RELEASES, now);
    return {
      harness,
      harnessVersion,
      architectures: imagesFor(release, harness, harnessVersion).map((image) => image.architecture),
    };
  }

  private async guestImage(
    tenantId: string,
    session: SessionRow,
    hostId: string,
    claimSeconds: number,
    fetchSeconds: number,
    now: number,
  ): Promise<{ kind: "Released"; image: GuestImageDownload } | { kind: "NotReleased"; detail: string }> {
    const host = await hostOf(this.env.DB, tenantId, hostId);
    if (host === null)
      throw new Error(
        `turn of session ${session.session_id} is offered to host ${hostId}, which tenant ${tenantId} does not list`,
      );
    const release = await currentRelease(this.env.RELEASES, now);
    const image = imagesFor(release, session.harness, session.harness_version).find(
      (each) => each.architecture === host.architecture,
    );
    if (image === undefined) {
      return {
        kind: "NotReleased",
        detail: `the current release carries no ${session.harness} ${session.harness_version} guest image for ${host.architecture}, the architecture of host ${host.name} (${hostId}); pin a version tumpel release current lists for ${host.architecture} with tumpel harness pin, then send the turn again`,
      };
    }
    const signer = signerOf(
      this.env,
      this.env.RELEASES_BUCKET_NAME,
      this.env.RELEASES_ACCESS_KEY_ID,
      this.env.RELEASES_SECRET_ACCESS_KEY,
    );
    const at = new Date(now);
    const seconds = claimSeconds + fetchSeconds;
    return {
      kind: "Released",
      image: {
        imageDigest: image.imageDigest,
        kernelDigest: image.kernelDigest,
        manifestDigest: image.manifestDigest,
        imageUrl: await signer.presign("GET", imageKey(image), seconds, at),
        kernelUrl: await signer.presign("GET", kernelKey(image), seconds, at),
        manifestUrl: await signer.presign("GET", manifestKey(image), seconds, at),
        downloadExpiresAt: iso(now + seconds * 1000),
        fetchSeconds,
      },
    };
  }

  startSession(tenantId: string, input: NewSession, now: number): Promise<Started<StartedSession>> {
    return this.begin(tenantId, input, now, () => undefined);
  }

  async startSessionFromIssue(
    tenantId: string,
    input: NewSession,
    issue: IssueOfSession,
    now: number,
  ): Promise<Started<StartedSessionFromIssue>> {
    const begun = await this.begin(tenantId, input, now, (sessionId) => {
      this.ctx.storage.sql.exec(
        "INSERT INTO session_issues (session_id, issue_number, title, html_url, branch) VALUES (?, ?, ?, ?, ?)",
        sessionId,
        issue.issueNumber,
        issue.title,
        issue.htmlUrl,
        issue.branch,
      );
    });
    if (begun.kind === "Unplaced") return begun;
    return {
      kind: "Started",
      started: { ...begun.started, issue: { sessionId: begun.started.session.sessionId, ...issue } },
    };
  }

  private async begin(
    tenantId: string,
    input: NewSession,
    now: number,
    record: (sessionId: string) => void,
  ): Promise<Started<StartedSession>> {
    const { start } = input;
    const image = await this.imageAvailability(input.harness, input.harnessVersion, now);
    const placement = placeSession(input.hosts, this.listHostUsage(tenantId), image);
    if (placement.kind === "Refused") return { kind: "Unplaced", hosts: placement.hosts };
    const session: SessionRow = {
      session_id: crypto.randomUUID(),
      principal_id: input.principalId,
      host_id: placement.host.hostId,
      box_id: crypto.randomUUID(),
      persona_id: start.personaId,
      repository: start.repository,
      harness: input.harness,
      harness_version: input.harnessVersion,
      model: start.model,
      state: "Starting",
      last_line_seq: 0,
      endpoint: input.endpoint,
      created_at: now,
      updated_at: now,
    };
    const turn = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO sessions (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        session.session_id,
        session.principal_id,
        session.host_id,
        session.box_id,
        session.persona_id,
        session.repository,
        session.harness,
        session.harness_version,
        session.model,
        session.state,
        session.last_line_seq,
        session.endpoint,
        session.created_at,
        session.updated_at,
      );
      record(session.session_id);
      return this.insertTurn(session.session_id, session.host_id, session.box_id, start.prompt, now);
    });
    await this.offer(tenantId, session, turn);
    return {
      kind: "Started",
      started: { session: this.presentSession(tenantId, session.session_id), turn: toTurn(tenantId, turn) },
    };
  }

  async sendTurn(tenantId: string, sessionId: string, prompt: string, hosts: Host[], now: number): Promise<Sent> {
    const session = this.sessionRow(sessionId);
    if (session === null) return { kind: "NotFound" };
    if (session.state === "Archived") return { kind: "Archived" };
    if (session.state === "Stopping") return { kind: "Stopping" };
    const running = this.inFlightTurn(sessionId);
    if (running !== null) return { kind: "InFlight", turnId: running };
    const refusal = this.refusedCredential(session, now);
    if (refusal !== null) return { kind: "CredentialRefused", personaId: session.persona_id, refusal };
    if (hosts.some((host) => host.hostId === session.host_id && host.state === "Online")) {
      const boxId = session.state === "Stopped" ? crypto.randomUUID() : session.box_id;
      const turn = this.runTurn(session, session.host_id, boxId, prompt, now);
      await this.offer(tenantId, { ...session, box_id: boxId }, turn);
      return { kind: "Sent", turn: toTurn(tenantId, turn) };
    }
    const missingTurnIds = this.unsnapshottedTurns(sessionId);
    if (missingTurnIds.length > 0) return { kind: "Stranded", missingTurnIds };
    const image = await this.imageAvailability(session.harness, session.harness_version, now);
    const placement = placeSession(hosts, this.listHostUsage(tenantId), image);
    if (placement.kind === "Refused") return { kind: "Unplaced", hosts: placement.hosts };
    const hostId = placement.host.hostId;
    const boxId = crypto.randomUUID();
    this.settleSnapshotRequests(session, hostId, iso(now));
    const turn = this.runTurn(session, hostId, boxId, prompt, now);
    await this.timers(tenantId, sessionId, { SnapshotAnswer: null });
    if (session.state !== "Stopped") {
      await this.host(session.host_id).send({ type: "BoxDiscard", sessionId, boxId: session.box_id });
    }
    await this.offer(tenantId, { ...session, host_id: hostId, box_id: boxId }, turn);
    return { kind: "Sent", turn: toTurn(tenantId, turn) };
  }

  private runTurn(session: SessionRow, hostId: string, boxId: string, prompt: string, now: number): TurnRow {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE sessions SET state = 'Running', host_id = ?, box_id = ?, updated_at = ? WHERE session_id = ?",
        hostId,
        boxId,
        now,
        session.session_id,
      );
      return this.insertTurn(session.session_id, hostId, boxId, prompt, now);
    });
  }

  async stopSession(tenantId: string, sessionId: string, now: number): Promise<Stop> {
    const session = this.sessionRow(sessionId);
    if (session === null) return { kind: "NotFound" };
    if (session.state === "Archived") return { kind: "Archived" };
    if (session.state === "Stopping" || session.state === "Stopped") {
      return { kind: "Stopping", session: this.presentSession(tenantId, sessionId) };
    }
    const running = this.inFlightTurn(sessionId);
    if (running !== null) return { kind: "InFlight", turnId: running };
    const latest = this.latestTurn(sessionId, null);
    if (latest === null) throw new Error(`session ${sessionId} has no turn, though a start always offers one`);
    this.setSessionState(sessionId, "Stopping", now);
    await this.timers(tenantId, sessionId, { Snapshot: null });
    const stopping = { ...session, state: "Stopping", updated_at: now };
    await this.snapshotOrTeardown(tenantId, stopping, latest);
    return { kind: "Stopping", session: this.presentSession(tenantId, sessionId) };
  }

  async archiveSession(tenantId: string, sessionId: string, now: number): Promise<Archive> {
    const session = this.sessionRow(sessionId);
    if (session === null) return { kind: "NotFound" };
    if (session.state !== "Stopped" && session.state !== "Archived") {
      return { kind: "NotStopped", state: SessionSchema.shape.state.parse(session.state) };
    }
    const sql = this.ctx.storage.sql;
    if (session.state === "Stopped") this.setSessionState(sessionId, "Archived", now);
    const keys = sql
      .exec<{ storage_key: string }>(
        "SELECT storage_key FROM snapshots WHERE session_id = ?1 UNION SELECT storage_key FROM snapshot_failures WHERE session_id = ?1 AND storage_key != ''",
        sessionId,
      )
      .toArray()
      .map((row) => row.storage_key);
    this.ctx.storage.transactionSync(() => {
      for (const pending of ["snapshot_packs", "snapshot_chunks"]) {
        sql.exec(
          `DELETE FROM ${pending} WHERE snapshot_id IN (SELECT snapshot_id FROM snapshot_requests WHERE session_id = ?1 UNION SELECT snapshot_id FROM snapshot_failures WHERE session_id = ?1)`,
          sessionId,
        );
      }
      sql.exec("DELETE FROM snapshots WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM snapshot_failures WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM snapshot_requests WHERE session_id = ?", sessionId);
    });
    for (let start = 0; start < keys.length; start += STORE_DELETE_BATCH) {
      await this.env.STORE.delete(keys.slice(start, start + STORE_DELETE_BATCH));
    }
    await this.releaseChunks(tenantId, sessionId);
    await this.timers(tenantId, sessionId, {
      Claim: null,
      ImageFetch: null,
      FirstLine: null,
      Total: null,
      Snapshot: null,
      SnapshotAnswer: null,
      Teardown: null,
      TeardownAnswer: null,
      HostOffline: null,
    });
    return { kind: "Archived", session: this.presentSession(tenantId, sessionId) };
  }

  private releaseChunks(tenantId: string, sessionId: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    return this.ctx.blockConcurrencyWhile(async () => {
      const dead = this.ctx.storage.transactionSync(() => {
        sql.exec(`DELETE FROM chunks WHERE digest IN (${ORPHAN_CHUNKS})`, sessionId);
        sql.exec("DELETE FROM session_chunks WHERE session_id = ?", sessionId);
        const packs = sql
          .exec<{ pack_digest: string }>(`SELECT pack_digest ${DEAD_PACKS}`)
          .toArray()
          .map((row) => row.pack_digest);
        sql.exec(`DELETE ${DEAD_PACKS}`);
        return packs;
      });
      for (let start = 0; start < dead.length; start += STORE_DELETE_BATCH) {
        await this.env.STORE.delete(
          dead.slice(start, start + STORE_DELETE_BATCH).map((packDigest) => packKey(tenantId, packDigest)),
        );
      }
    });
  }

  private async snapshotOrTeardown(tenantId: string, session: SessionRow, latest: TurnRow): Promise<void> {
    const [pending] = this.ctx.storage.sql
      .exec<{ snapshot_id: string }>(
        "SELECT snapshot_id FROM snapshot_requests WHERE session_id = ? LIMIT 1",
        session.session_id,
      )
      .toArray();
    if (pending !== undefined) return;
    const now = Date.now();
    const completed = this.latestTurn(session.session_id, "Completed");
    if (completed === null)
      return this.timers(tenantId, session.session_id, { Teardown: { turnId: latest.turn_id, at: now } });
    const [held] = this.ctx.storage.sql
      .exec<{ snapshot_id: string }>(
        "SELECT snapshot_id FROM snapshots WHERE session_id = ? AND turn_id = ? LIMIT 1",
        session.session_id,
        completed.turn_id,
      )
      .toArray();
    if (held !== undefined) {
      return this.timers(tenantId, session.session_id, { Teardown: { turnId: latest.turn_id, at: now } });
    }
    return this.timers(tenantId, session.session_id, { Snapshot: { turnId: completed.turn_id, at: now } });
  }

  private async teardown(tenantId: string, session: SessionRow, turnId: string): Promise<void> {
    const seconds = settingsOf(this.env).snapshotDeadlineSeconds;
    await this.timers(tenantId, session.session_id, {
      TeardownAnswer: { turnId, at: Date.now() + seconds * 1000 },
    });
    await this.host(session.host_id).send({
      type: "BoxTeardown",
      sessionId: session.session_id,
      boxId: session.box_id,
    });
  }

  private async teardownAnswer(
    tenantId: string,
    hostId: string,
    message: Extract<HostMessage, { type: "BoxGone" | "BoxTeardownFailed" }>,
  ): Promise<void> {
    const session = this.sessionRow(message.sessionId);
    const asked =
      session !== null &&
      (session.box_id === message.boxId ? session.host_id === hostId : this.ranBox(session, message.boxId, hostId));
    if (session === null || !asked) {
      throw new Error(
        `host ${hostId} answered the teardown of box ${message.boxId} of session ${message.sessionId} of tenant ${tenantId}, which it was not asked for`,
      );
    }
    if (session.box_id !== message.boxId || session.state !== "Stopping") return;
    await this.timers(tenantId, session.session_id, { TeardownAnswer: null });
    if (message.type === "BoxGone") return this.setSessionState(session.session_id, "Stopped", Date.now());
    this.recordStopFailure(session.session_id, message.reason, message.detail, message.failedAt);
    this.returnToIdle(session.session_id);
    return this.rearmSnapshot(tenantId, session.session_id);
  }

  private ranBox(session: SessionRow, boxId: string, hostId: string): boolean {
    const [ran] = this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        "SELECT turn_id FROM turns WHERE session_id = ? AND box_id = ? AND host_id = ? LIMIT 1",
        session.session_id,
        boxId,
        hostId,
      )
      .toArray();
    return ran !== undefined;
  }

  private recordStopFailure(sessionId: string, reason: StopFailure["reason"], detail: string, failedAt: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO stop_failures (stop_failure_id, session_id, reason, detail, failed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      sessionId,
      reason,
      detail,
      failedAt,
      Date.now(),
    );
  }

  private returnToIdle(sessionId: string): void {
    this.setSessionState(sessionId, "Idle", Date.now());
  }

  private async rearmSnapshot(tenantId: string, sessionId: string): Promise<void> {
    const now = Date.now();
    const turn = this.latestTurn(sessionId, "Completed") ?? this.latestTurn(sessionId, null);
    if (turn === null) throw new Error(`session ${sessionId} has no turn, though a start always offers one`);
    await this.timers(tenantId, sessionId, {
      Snapshot: { turnId: turn.turn_id, at: now + settingsOf(this.env).snapshotDelaySeconds * 1000 },
    });
  }

  getSession(tenantId: string, sessionId: string): Session | null {
    const [row] = this.ctx.storage.sql
      .exec<SessionViewRow>(`${SESSION_VIEW_SELECT} WHERE s.session_id = ?`, sessionId)
      .toArray();
    return row === undefined ? null : toSession(tenantId, row);
  }

  listSessions(tenantId: string, filter: SessionFilter): Session[] {
    return this.ctx.storage.sql
      .exec<SessionViewRow>(
        `${SESSION_VIEW_SELECT} WHERE (?1 IS NULL OR s.state = ?1) AND (?2 IS NULL OR s.host_id = ?2) ORDER BY s.created_at, s.session_id`,
        filter.state ?? null,
        filter.hostId ?? null,
      )
      .toArray()
      .map((row) => toSession(tenantId, row));
  }

  listTurns(tenantId: string, sessionId: string): Turn[] | null {
    if (this.sessionRow(sessionId) === null) return null;
    return this.ctx.storage.sql
      .exec<TurnRow>(`${TURN_SELECT} WHERE session_id = ? ORDER BY created_at, turn_id`, sessionId)
      .toArray()
      .map((row) => toTurn(tenantId, row));
  }

  getTurn(tenantId: string, turnId: string): Turn | null {
    const row = this.turnRow(turnId);
    return row === null ? null : toTurn(tenantId, row);
  }

  getTurnFailure(tenantId: string, turnId: string): TurnFailure | null {
    const [row] = this.ctx.storage.sql
      .exec<FailureRow>(
        "SELECT turn_id, session_id, reason, detail, failed_at, created_at FROM turn_failures WHERE turn_id = ?",
        turnId,
      )
      .toArray();
    if (row === undefined) return null;
    return TurnFailureSchema.parse({
      turnId: row.turn_id,
      tenantId,
      sessionId: row.session_id,
      reason: row.reason,
      detail: row.detail,
      failedAt: row.failed_at,
      createdAt: row.created_at,
    });
  }

  listStopFailures(tenantId: string, sessionId: string): StopFailure[] | null {
    if (this.sessionRow(sessionId) === null) return null;
    return this.ctx.storage.sql
      .exec<StopFailureRow>(
        "SELECT stop_failure_id, session_id, reason, detail, failed_at, created_at FROM stop_failures WHERE session_id = ? ORDER BY created_at, stop_failure_id",
        sessionId,
      )
      .toArray()
      .map((row) =>
        StopFailureSchema.parse({
          stopFailureId: row.stop_failure_id,
          tenantId,
          sessionId: row.session_id,
          reason: row.reason,
          detail: row.detail,
          failedAt: row.failed_at,
          createdAt: row.created_at,
        }),
      );
  }

  listSnapshots(tenantId: string, sessionId: string): Snapshot[] | null {
    if (this.sessionRow(sessionId) === null) return null;
    return this.ctx.storage.sql
      .exec<SnapshotRow>(`${SNAPSHOT_SELECT} WHERE session_id = ? ORDER BY snapshot_seq`, sessionId)
      .toArray()
      .map((row) => toSnapshot(tenantId, row));
  }

  listCredentialHandovers(tenantId: string, sessionId: string): CredentialHandover[] | null {
    if (this.sessionRow(sessionId) === null) return null;
    return this.ctx.storage.sql
      .exec<HandoverRow>(
        `SELECT credential_handovers.credential_handover_id, turns.session_id, credential_handovers.turn_id,
          credential_handovers.host_id, turns.box_id, credential_handovers.variable_names,
          credential_handovers.repository_credential_source, credential_handovers.created_at
        FROM credential_handovers JOIN turns USING (turn_id)
        WHERE turns.session_id = ? ORDER BY credential_handovers.created_at, credential_handovers.rowid`,
        sessionId,
      )
      .toArray()
      .map((row) => toHandover(tenantId, row));
  }

  getSnapshot(tenantId: string, snapshotId: string): Snapshot | null {
    const [row] = this.ctx.storage.sql
      .exec<SnapshotRow>(`${SNAPSHOT_SELECT} WHERE snapshot_id = ?`, snapshotId)
      .toArray();
    return row === undefined ? null : toSnapshot(tenantId, row);
  }

  transcriptCursor(
    tenantId: string,
    sessionId: string,
    after: number,
    turnId: string | null,
    limit: number,
    maxBytes: number | null,
  ): TranscriptCursor | null {
    const session = this.sessionRow(sessionId);
    if (session === null) return null;
    const sql = this.ctx.storage.sql;
    const [tail] = sql
      .exec<{ last_line_seq: number; in_flight: number }>(
        `SELECT MAX(
          COALESCE((SELECT MAX(last_line_seq) FROM transcript_chunks WHERE session_id = ?1 AND (?2 IS NULL OR turn_id = ?2)), 0),
          COALESCE((SELECT MAX(line_seq) FROM transcript_pending WHERE session_id = ?1 AND (?2 IS NULL OR turn_id = ?2)), 0)
        ) AS last_line_seq,
        EXISTS (SELECT 1 FROM turns WHERE session_id = ?1 AND (?2 IS NULL OR turn_id = ?2) AND state IN (${IN_FLIGHT.map((_, index) => `?${index + 3}`).join(", ")})) AS in_flight`,
        sessionId,
        turnId,
        ...IN_FLIGHT,
      )
      .toArray();
    const known = {
      sessionState: SessionSchema.shape.state.parse(session.state),
      harness: SessionSchema.shape.harness.parse(session.harness),
      lastLineSeq: tail?.last_line_seq ?? 0,
      inFlight: tail?.in_flight === 1,
    };
    const [chunk] = sql
      .exec<ChunkRow>(
        `SELECT storage_key, line_seqs, offsets FROM transcript_chunks
        WHERE session_id = ?1 AND last_line_seq > ?2 AND (?3 IS NULL OR turn_id = ?3)
        ORDER BY last_line_seq LIMIT 1`,
        sessionId,
        after,
        turnId,
      )
      .toArray();
    if (chunk !== undefined) {
      const range = rangeAfter(JSON.parse(chunk.line_seqs), JSON.parse(chunk.offsets), after, limit, maxBytes);
      if (range === null) throw new Error(`transcript chunk ${chunk.storage_key} holds no line after ${after}`);
      return { ...known, kind: "Chunk", storageKey: chunk.storage_key, range };
    }
    const lines = sql
      .exec<PendingRow>(
        `SELECT session_id, line_seq, turn_id, text, created_at FROM transcript_pending
        WHERE session_id = ?1 AND line_seq > ?2 AND (?3 IS NULL OR turn_id = ?3)
        ORDER BY line_seq LIMIT ?4`,
        sessionId,
        after,
        turnId,
        limit,
      )
      .toArray()
      .map((row) => toLine(tenantId, row));
    return { ...known, kind: "Lines", lines: linesWithin(lines, maxBytes) };
  }

  async prepareOffer(tenantId: string, turnId: string, hostId: string, now: number): Promise<PreparedOffer> {
    const turn = this.turnRow(turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null) {
      throw new Error(`host ${hostId} has an offer for turn ${turnId}, which tenant ${tenantId} does not hold`);
    }
    if (turn.state !== "Offered") return { kind: "Withdrawn" };
    const entry = catalogEntry(session.harness, session.harness_version);
    if (entry === undefined) {
      throw new Error(
        `session ${session.session_id} runs ${session.harness} ${session.harness_version}, which left the catalog`,
      );
    }
    const persona = this.personaRow(session.persona_id);
    if (persona === null) {
      throw new Error(
        `session ${session.session_id} runs on persona ${session.persona_id}, which is gone; turn ${turnId} has no secret set to run on`,
      );
    }
    const { secretSetId } = persona;
    const dispatch = dispatchVariables(entry, await this.members(secretSetId), now);
    if (dispatch.kind === "NoCredential") {
      throw new Error(
        `secret set ${secretSetId} holds no ${dispatch.provider} credential for turn ${turnId}; add one with tumpel config apply`,
      );
    }
    if (dispatch.kind === "Unsupported") {
      throw new Error(
        `secret set ${secretSetId} holds ${dispatch.name}, a ${dispatch.credentialKind}, which ${session.harness} does not accept for turn ${turnId}; it accepts ${dispatch.supported.join(", ")}`,
      );
    }
    if (dispatch.kind === "Expired") {
      await this.failTurn(
        tenantId,
        turnId,
        "CredentialExpired",
        `subscription token ${dispatch.name} of secret set ${secretSetId} expired at ${dispatch.expiresAt}; write a fresh token and its expiresAt with tumpel config apply, then send the turn again`,
        iso(now),
      );
      return { kind: "Withdrawn" };
    }
    const settings = settingsOf(this.env);
    const guest = await this.guestImage(
      tenantId,
      session,
      hostId,
      settings.turnClaimBudgetSeconds,
      settings.turnImageFetchBudgetSeconds,
      now,
    );
    if (guest.kind === "NotReleased") {
      await this.failTurn(tenantId, turnId, "ImageNotReleased", guest.detail, iso(now));
      return { kind: "Withdrawn" };
    }
    const target = githubRepository(session.repository);
    const minted: Minted = target === null ? { kind: "NoToken" } : await this.repositoryToken(tenantId, target, now);
    const credential = repositoryCredential(dispatch.variables, minted);
    if (credential.kind === "Refused") {
      await this.failTurn(tenantId, turnId, "RepositoryTokenRefused", credential.detail, iso(now));
      return { kind: "Withdrawn" };
    }
    const { variables, source } = credential;
    const identity = await this.commitIdentityOf(minted, source, secretSetId, turnId);
    if (identity.kind === "Refused") {
      await this.failTurn(tenantId, turnId, "RepositoryTokenRefused", identity.detail, iso(now));
      return { kind: "Withdrawn" };
    }
    const handover = {
      credentialHandoverId: crypto.randomUUID(),
      turnId,
      hostId,
      variableNames: variables.map((variable) => variable.name),
      createdAt: now,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO credential_handovers (credential_handover_id, turn_id, host_id, variable_names, repository_credential_source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      handover.credentialHandoverId,
      handover.turnId,
      handover.hostId,
      JSON.stringify(handover.variableNames),
      source,
      handover.createdAt,
    );
    const stored = this.ctx.storage.sql
      .exec<{ snapshot_id: string; snapshot_seq: number; storage_key: string }>(
        "SELECT snapshot_id, snapshot_seq, storage_key FROM snapshots WHERE session_id = ? ORDER BY snapshot_seq DESC LIMIT 1",
        session.session_id,
      )
      .toArray();
    const credentialSeconds = turnCredentialSeconds(settings);
    const snapshots = await this.downloads(stored, credentialSeconds, now);
    const personaFiles = await this.personaFiles(tenantId, session.persona_id, credentialSeconds, now);
    return {
      kind: "Ready",
      credential: {
        credentialHandoverId: handover.credentialHandoverId,
        expiresAt: iso(now + credentialSeconds * 1000),
        variables,
      },
      lastLineSeq: session.last_line_seq,
      snapshots,
      personaFiles,
      image: guest.image,
      ...identity.identity,
    };
  }

  private async personaFiles(
    tenantId: string,
    personaId: string,
    seconds: number,
    now: number,
  ): Promise<PersonaFileDownload[]> {
    const files = this.ctx.storage.sql
      .exec<{ path: string; digest: string; size_bytes: number }>(
        "SELECT path, digest, size_bytes FROM persona_files WHERE persona_id = ? ORDER BY path",
        personaId,
      )
      .toArray();
    if (files.length === 0) return [];
    const signer = signerOf(
      this.env,
      this.env.R2_BUCKET_NAME,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    );
    const downloads: PersonaFileDownload[] = [];
    for (const file of files) {
      downloads.push({
        path: file.path,
        digest: file.digest,
        sizeBytes: file.size_bytes,
        downloadUrl: await signer.presign("GET", personaFileKey(tenantId, file.digest), seconds, new Date(now)),
        downloadExpiresAt: iso(now + seconds * 1000),
      });
    }
    return downloads;
  }

  private async downloads(
    stored: { snapshot_id: string; snapshot_seq: number; storage_key: string }[],
    seconds: number,
    now: number,
  ): Promise<SnapshotDownload[]> {
    if (stored.length === 0) return [];
    const signer = signerOf(
      this.env,
      this.env.R2_BUCKET_NAME,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    );
    const snapshots: SnapshotDownload[] = [];
    for (const row of stored) {
      snapshots.push({
        snapshotId: row.snapshot_id,
        snapshotSeq: row.snapshot_seq,
        storageKey: row.storage_key,
        downloadUrl: await signer.presign("GET", row.storage_key, seconds, new Date(now)),
        downloadExpiresAt: iso(now + seconds * 1000),
      });
    }
    return snapshots;
  }

  async hostPresence(tenantId: string, hostId: string, presence: "Online" | "Offline", now: number): Promise<void> {
    const inFlight = this.ctx.storage.sql
      .exec<{ session_id: string; turn_id: string }>(
        `SELECT session_id, turn_id FROM turns WHERE host_id = ? AND state IN (${IN_FLIGHT.map(() => "?").join(", ")})`,
        hostId,
        ...IN_FLIGHT,
      )
      .toArray();
    for (const { session_id, turn_id } of inFlight) {
      await this.timers(tenantId, session_id, {
        HostOffline: presence === "Offline" ? { turnId: turn_id, at: now + HEARTBEAT_DEADLINE_MS } : null,
      });
    }
  }

  private async hostOffline(hostId: string): Promise<boolean> {
    const row = await this.env.DB.prepare("SELECT state FROM hosts WHERE host_id = ?")
      .bind(hostId)
      .first<{ state: string }>();
    return row?.state === "Offline";
  }

  async hostMessage(tenantId: string, hostId: string, message: SessionHostMessage): Promise<ChunkReply | null> {
    if (message.type === "SnapshotChunks") return this.snapshotChunks(tenantId, hostId, message);
    if (message.type === "SnapshotPacks") return this.snapshotPacks(tenantId, hostId, message);
    if (message.type === "RestoreChunks") return this.restoreChunks(tenantId, hostId, message);
    await this.hostEvent(tenantId, hostId, message);
    return null;
  }

  private snapshotUploadWindow(
    tenantId: string,
    hostId: string,
    snapshotId: string,
  ): { request: SnapshotRequestRow; now: number; expiresAt: number; seconds: number } | null {
    const [request] = this.ctx.storage.sql
      .exec<SnapshotRequestRow & { created_at: number }>(
        "SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, created_at FROM snapshot_requests WHERE snapshot_id = ?",
        snapshotId,
      )
      .toArray();
    if (request === undefined) return null;
    if (this.sessionRow(request.session_id)?.host_id !== hostId) {
      throw new Error(
        `host ${hostId} sent chunks of snapshot ${snapshotId} of tenant ${tenantId}, which it was not asked for`,
      );
    }
    const now = Date.now();
    const expiresAt = request.created_at + settingsOf(this.env).snapshotDeadlineSeconds * 1000;
    const seconds = Math.floor((expiresAt - now) / 1000);
    if (seconds < 1) return null;
    return { request, now, expiresAt, seconds };
  }

  private snapshotChunks(
    tenantId: string,
    hostId: string,
    message: Extract<ChunkAsk, { type: "SnapshotChunks" }>,
  ): ChunkReply | null {
    const window = this.snapshotUploadWindow(tenantId, hostId, message.snapshotId);
    if (window === null) return null;
    const sql = this.ctx.storage.sql;
    const digests = JSON.stringify(message.digests);
    const held = this.ctx.storage.transactionSync(() => {
      sql.exec(
        "INSERT OR IGNORE INTO session_chunks (session_id, digest) SELECT ?1, value FROM json_each(?2)",
        window.request.session_id,
        digests,
      );
      return sql
        .exec<{ digest: string; pack_digest: string; byte_offset: number; byte_length: number }>(
          "SELECT digest, MIN(pack_digest) AS pack_digest, byte_offset, byte_length FROM chunks WHERE digest IN (SELECT value FROM json_each(?1)) GROUP BY digest ORDER BY digest",
          digests,
        )
        .toArray();
    });
    return {
      type: "SnapshotChunksHeld",
      snapshotId: message.snapshotId,
      part: message.part,
      held: held.map((row) => ({
        digest: row.digest,
        packDigest: row.pack_digest,
        offset: row.byte_offset,
        length: row.byte_length,
      })),
    };
  }

  private async snapshotPacks(
    tenantId: string,
    hostId: string,
    message: Extract<ChunkAsk, { type: "SnapshotPacks" }>,
  ): Promise<ChunkReply | null> {
    const window = this.snapshotUploadWindow(tenantId, hostId, message.snapshotId);
    if (window === null) return null;
    const listed = new Set(message.packs.map((pack) => pack.packDigest));
    const unlisted = message.chunks.find((chunk) => !listed.has(chunk.packDigest));
    if (unlisted !== undefined) {
      throw new Error(
        `host ${hostId} placed chunk ${unlisted.digest} of snapshot ${message.snapshotId} in pack ${unlisted.packDigest}, which part ${message.part} does not list`,
      );
    }
    const sql = this.ctx.storage.sql;
    const { request } = window;
    const missing = this.ctx.storage.transactionSync(() => {
      for (const pack of message.packs) {
        sql.exec(
          "INSERT OR IGNORE INTO snapshot_packs (snapshot_id, pack_digest, size_bytes) VALUES (?, ?, ?)",
          request.snapshot_id,
          pack.packDigest,
          pack.sizeBytes,
        );
      }
      for (const chunk of message.chunks) {
        sql.exec(
          "INSERT OR IGNORE INTO snapshot_chunks (snapshot_id, digest, pack_digest, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?)",
          request.snapshot_id,
          chunk.digest,
          chunk.packDigest,
          chunk.offset,
          chunk.length,
        );
        sql.exec(
          "INSERT OR IGNORE INTO session_chunks (session_id, digest) VALUES (?, ?)",
          request.session_id,
          chunk.digest,
        );
      }
      const stored = new Set(
        sql
          .exec<{ pack_digest: string }>(
            "SELECT pack_digest FROM packs WHERE pack_digest IN (SELECT value FROM json_each(?1))",
            JSON.stringify([...listed]),
          )
          .toArray()
          .map((row) => row.pack_digest),
      );
      return message.packs.filter((pack) => !stored.has(pack.packDigest));
    });
    const signer = signerOf(
      this.env,
      this.env.R2_BUCKET_NAME,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    );
    const uploads = [];
    for (const pack of missing) {
      uploads.push({
        packDigest: pack.packDigest,
        sizeBytes: pack.sizeBytes,
        url: await signer.presignChecked(
          packKey(tenantId, pack.packDigest),
          pack.packDigest,
          pack.sizeBytes,
          window.seconds,
          new Date(window.now),
        ),
      });
    }
    return {
      type: "SnapshotPackUploads",
      snapshotId: message.snapshotId,
      part: message.part,
      uploads,
      uploadExpiresAt: iso(window.expiresAt),
    };
  }

  private async restoreChunks(
    tenantId: string,
    hostId: string,
    message: Extract<ChunkAsk, { type: "RestoreChunks" }>,
  ): Promise<ChunkReply | null> {
    const turn = this.turnRow(message.turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null || turn.host_id !== hostId) {
      throw new Error(`host ${hostId} asked for the chunks of turn ${message.turnId}, which is not offered to it`);
    }
    if (!IN_FLIGHT.includes(turn.state)) return null;
    const sql = this.ctx.storage.sql;
    const [offered] = sql
      .exec<{ offered_at: number | null }>(
        "SELECT MAX(created_at) AS offered_at FROM credential_handovers WHERE turn_id = ?",
        message.turnId,
      )
      .toArray();
    if (offered?.offered_at === null || offered?.offered_at === undefined) {
      throw new Error(`host ${hostId} asked for the chunks of turn ${message.turnId}, which was never sent to it`);
    }
    const now = Date.now();
    const expiresAt = offered.offered_at + turnCredentialSeconds(settingsOf(this.env)) * 1000;
    const seconds = Math.floor((expiresAt - now) / 1000);
    if (seconds < 1) return null;
    const packs = sql
      .exec<{ pack_digest: string; size_bytes: number; held: number }>(
        `WITH asked AS (
          SELECT json_extract(value, '$.digest') AS digest, json_extract(value, '$.packDigest') AS pack_digest,
            json_extract(value, '$.offset') AS byte_offset, json_extract(value, '$.length') AS byte_length
          FROM json_each(?1)
        )
        SELECT asked.pack_digest, packs.size_bytes, MIN(
          EXISTS (SELECT 1 FROM chunks WHERE chunks.digest = asked.digest AND chunks.pack_digest = asked.pack_digest
            AND chunks.byte_offset = asked.byte_offset AND chunks.byte_length = asked.byte_length)
          AND EXISTS (SELECT 1 FROM session_chunks WHERE session_chunks.session_id = ?2 AND session_chunks.digest = asked.digest)
        ) AS held
        FROM asked JOIN packs ON packs.pack_digest = asked.pack_digest
        GROUP BY asked.pack_digest ORDER BY asked.pack_digest`,
        JSON.stringify(message.chunks),
        session.session_id,
      )
      .toArray()
      .filter((row) => row.held === 1);
    const signer = signerOf(
      this.env,
      this.env.R2_BUCKET_NAME,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    );
    const downloads = [];
    for (const pack of packs) {
      downloads.push({
        packDigest: pack.pack_digest,
        sizeBytes: pack.size_bytes,
        url: await signer.presign("GET", packKey(tenantId, pack.pack_digest), seconds, new Date(now)),
      });
    }
    return {
      type: "RestoreDownloads",
      turnId: message.turnId,
      part: message.part,
      packs: downloads,
      downloadExpiresAt: iso(expiresAt),
    };
  }

  private async hostEvent(tenantId: string, hostId: string, message: HostEvent): Promise<void> {
    if (message.type === "SnapshotDone" || message.type === "SnapshotFailed") {
      return this.snapshotAnswer(tenantId, hostId, message);
    }
    if (message.type === "BoxGone" || message.type === "BoxTeardownFailed") {
      return this.teardownAnswer(tenantId, hostId, message);
    }
    const turn = this.turnRow(message.turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null || turn.host_id !== hostId) {
      throw new Error(`host ${hostId} sent ${message.type} for turn ${message.turnId}, which is not offered to it`);
    }
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    if (message.type === "TurnImageFetching") {
      if (turn.state !== "Offered") return;
      const settings = settingsOf(this.env);
      return this.timers(tenantId, session.session_id, {
        Claim: null,
        ImageFetch: {
          turnId: turn.turn_id,
          imageDigest: message.imageDigest,
          at: now + (settings.turnImageFetchBudgetSeconds + settings.turnClaimBudgetSeconds) * 1000,
        },
      });
    }
    if (message.type === "TurnClaim") {
      if (turn.state !== "Offered") return;
      this.ctx.storage.transactionSync(() => {
        sql.exec("UPDATE turns SET state = 'Running', updated_at = ? WHERE turn_id = ?", now, turn.turn_id);
        sql.exec("UPDATE sessions SET state = 'Running', updated_at = ? WHERE session_id = ?", now, session.session_id);
      });
      const settings = settingsOf(this.env);
      return this.timers(tenantId, session.session_id, {
        Claim: null,
        ImageFetch: null,
        FirstLine: {
          turnId: turn.turn_id,
          at: now + (message.cloneSeconds + settings.turnFirstLineBudgetSeconds) * 1000,
        },
      });
    }
    if (message.type === "TurnRepositoryReady") {
      if (turn.state !== "Running" || turn.line_count > 0) return;
      const settings = settingsOf(this.env);
      return this.timers(tenantId, session.session_id, {
        FirstLine: { turnId: turn.turn_id, at: now + settings.turnFirstLineBudgetSeconds * 1000 },
      });
    }
    if (message.type === "TurnRepositoryCloneFailed") {
      const detail = this.cloneFailureDetail(session, message.detail);
      return this.failTurn(tenantId, turn.turn_id, "RepositoryCloneFailed", detail, message.failedAt);
    }
    if (message.type === "TurnFailed") {
      const detail =
        message.reason === "CredentialRefused" ? this.refusedSetDetail(session, message.detail) : message.detail;
      return this.failTurn(tenantId, turn.turn_id, message.reason, detail, message.failedAt);
    }
    if (turn.state !== "Running") return;
    if (message.type === "TurnLine")
      return this.appendLine(tenantId, session, turn, message.lineSeq, message.text, now);
    const held = this.sessionRow(session.session_id)?.last_line_seq ?? 0;
    if (message.lastLineSeq !== held) {
      return this.failTurn(
        tenantId,
        turn.turn_id,
        "TranscriptGap",
        `turn ${turn.turn_id} completed at lineSeq ${message.lastLineSeq}, but the control plane holds lines up to ${held}; the lines in between were lost on the channel, so send the turn again`,
        iso(now),
      );
    }
    await this.flush(tenantId, session.session_id, turn.turn_id);
    this.ctx.storage.transactionSync(() => {
      sql.exec("UPDATE turns SET state = 'Completed', updated_at = ? WHERE turn_id = ?", now, turn.turn_id);
      sql.exec("UPDATE sessions SET state = 'Idle', updated_at = ? WHERE session_id = ?", now, session.session_id);
    });
    await this.timers(tenantId, session.session_id, {
      Claim: null,
      ImageFetch: null,
      FirstLine: null,
      Total: null,
      HostOffline: null,
      Snapshot: { turnId: turn.turn_id, at: now + settingsOf(this.env).snapshotDelaySeconds * 1000 },
    });
  }

  async deadlineReached(tenantId: string, due: SessionDueDeadline): Promise<void> {
    const { turnId } = due.deadline;
    const { name } = due;
    const turn = this.turnRow(turnId);
    if (turn === null) return;
    const sessionId = turn.session_id;
    const session = this.sessionRow(sessionId);
    if (session === null) return;
    const settings = settingsOf(this.env);
    const failedAt = iso(Date.now());
    if (name === "Snapshot") return this.requestSnapshot(tenantId, session, turn);
    if (name === "SnapshotAnswer") return this.snapshotUnanswered(session, turn, failedAt);
    if (name === "Teardown" && session.state === "Stopping") return this.teardown(tenantId, session, turnId);
    if (name === "TeardownAnswer" && session.state === "Stopping") {
      this.recordStopFailure(
        sessionId,
        "NotAnswered",
        `host ${session.host_id} did not answer the teardown of box ${session.box_id} within ${settings.snapshotDeadlineSeconds} seconds; check that its supervisor runs with tumpel host list, then stop the session again`,
        failedAt,
      );
      return this.returnToIdle(sessionId);
    }
    if (name === "HostOffline" && IN_FLIGHT.includes(turn.state) && (await this.hostOffline(session.host_id))) {
      return this.failTurn(
        tenantId,
        turnId,
        "HostOffline",
        `host ${session.host_id} went offline during turn ${turnId} and did not reconnect within ${HEARTBEAT_DEADLINE_MS / 1000} seconds; check that its supervisor runs with tumpel host list, then send the turn again`,
        failedAt,
      );
    }
    if (name === "Claim" && turn.state === "Offered") {
      return this.failTurn(
        tenantId,
        turnId,
        "NotClaimed",
        `host ${session.host_id} did not claim turn ${turnId} within ${settings.turnClaimBudgetSeconds} seconds; check that its supervisor runs with tumpel host list, then send the turn again`,
        failedAt,
      );
    }
    if (due.name === "ImageFetch" && turn.state === "Offered") {
      return this.failTurn(
        tenantId,
        turnId,
        "ImageFetchTimedOut",
        `host ${session.host_id} started fetching guest image ${due.deadline.imageDigest} for turn ${turnId} and did not claim it within turnImageFetchBudgetSeconds ${settings.turnImageFetchBudgetSeconds} plus turnClaimBudgetSeconds ${settings.turnClaimBudgetSeconds}; check the host's bandwidth to the release bucket or raise turnImageFetchBudgetSeconds, then send the turn again`,
        failedAt,
      );
    }
    if (name === "FirstLine" && turn.state === "Running" && turn.line_count === 0) {
      return this.failTurn(
        tenantId,
        turnId,
        "NoFirstOutput",
        `the harness wrote no line for turn ${turnId} within ${settings.turnFirstLineBudgetSeconds} seconds of its repository being ready, or within the image's cloneSeconds plus turnFirstLineBudgetSeconds of the claim when no TurnRepositoryReady arrived; check the box on host ${session.host_id}, then send the turn again`,
        failedAt,
      );
    }
    if (name === "Total" && IN_FLIGHT.includes(turn.state)) {
      return this.failTurn(
        tenantId,
        turnId,
        "TurnTimedOut",
        `turn ${turnId} did not finish within ${settings.turnTotalBudgetSeconds} seconds; send a smaller prompt or raise turnTotalBudgetSeconds`,
        failedAt,
      );
    }
  }

  private async appendLine(
    tenantId: string,
    session: SessionRow,
    turn: TurnRow,
    lineSeq: number,
    text: string,
    now: number,
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    const held = this.sessionRow(session.session_id)?.last_line_seq ?? 0;
    if (lineSeq > held + 1) {
      return this.failTurn(
        tenantId,
        turn.turn_id,
        "TranscriptGap",
        `turn ${turn.turn_id} sent lineSeq ${lineSeq}, but the control plane holds lines up to ${held}; the lines in between were lost on the channel, so send the turn again`,
        iso(now),
      );
    }
    const pending = this.ctx.storage.transactionSync(() => {
      const [current] = sql
        .exec<{ last_line_seq: number }>("SELECT last_line_seq FROM sessions WHERE session_id = ?", session.session_id)
        .toArray();
      if (current === undefined || lineSeq <= current.last_line_seq) return null;
      sql.exec(
        "INSERT INTO transcript_pending (session_id, line_seq, turn_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
        session.session_id,
        lineSeq,
        turn.turn_id,
        text,
        now,
      );
      sql.exec("UPDATE turns SET line_count = line_count + 1, updated_at = ? WHERE turn_id = ?", now, turn.turn_id);
      sql.exec(
        "UPDATE sessions SET last_line_seq = ?, updated_at = ? WHERE session_id = ?",
        lineSeq,
        now,
        session.session_id,
      );
      const [count] = sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM transcript_pending WHERE session_id = ? AND turn_id = ?",
          session.session_id,
          turn.turn_id,
        )
        .toArray();
      return count?.count ?? 0;
    });
    if (pending === null) return;
    if (turn.line_count === 0) await this.timers(tenantId, session.session_id, { FirstLine: null });
    if (pending >= settingsOf(this.env).transcriptChunkLines)
      await this.flush(tenantId, session.session_id, turn.turn_id);
  }

  private async flush(tenantId: string, sessionId: string, turnId: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    const lines = sql
      .exec<PendingRow>(
        "SELECT session_id, line_seq, turn_id, text, created_at FROM transcript_pending WHERE session_id = ? AND turn_id = ? ORDER BY line_seq",
        sessionId,
        turnId,
      )
      .toArray()
      .map((row) => toLine(tenantId, row));
    const first = lines[0];
    const last = lines.at(-1);
    if (first === undefined || last === undefined) return;
    const chunk = encodeChunk(lines);
    const storageKey = chunkKey(tenantId, sessionId, turnId, first.lineSeq);
    await this.env.STORE.put(storageKey, chunk.body);
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        "INSERT INTO transcript_chunks (session_id, first_line_seq, last_line_seq, turn_id, storage_key, line_seqs, offsets) VALUES (?, ?, ?, ?, ?, ?, ?)",
        sessionId,
        first.lineSeq,
        last.lineSeq,
        turnId,
        storageKey,
        JSON.stringify(chunk.lineSeqs),
        JSON.stringify(chunk.offsets),
      );
      sql.exec(
        "DELETE FROM transcript_pending WHERE session_id = ? AND turn_id = ? AND line_seq <= ?",
        sessionId,
        turnId,
        last.lineSeq,
      );
    });
  }

  private async failTurn(
    tenantId: string,
    turnId: string,
    reason: TurnFailureReason,
    detail: string,
    failedAt: string,
  ): Promise<void> {
    const turn = this.turnRow(turnId);
    if (turn === null || !IN_FLIGHT.includes(turn.state)) return;
    await this.flush(tenantId, turn.session_id, turnId);
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("UPDATE turns SET state = 'Failed', updated_at = ? WHERE turn_id = ?", now, turnId);
      sql.exec("UPDATE sessions SET state = 'Idle', updated_at = ? WHERE session_id = ?", now, turn.session_id);
      sql.exec(
        "INSERT INTO turn_failures (turn_id, session_id, reason, detail, failed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        turnId,
        turn.session_id,
        reason,
        detail,
        failedAt,
        now,
      );
    });
    await this.timers(tenantId, turn.session_id, {
      Claim: null,
      ImageFetch: null,
      FirstLine: null,
      Total: null,
      HostOffline: null,
    });
  }

  private async requestSnapshot(tenantId: string, session: SessionRow, turn: TurnRow): Promise<void> {
    if (session.state !== "Idle" && session.state !== "Stopping") return;
    const sql = this.ctx.storage.sql;
    const [latest] = sql
      .exec<{ seq: number | null }>(
        "SELECT MAX(seq) AS seq FROM (SELECT snapshot_seq AS seq FROM snapshots WHERE session_id = ?1 UNION ALL SELECT snapshot_seq FROM snapshot_requests WHERE session_id = ?1 UNION ALL SELECT snapshot_seq FROM snapshot_failures WHERE session_id = ?1)",
        session.session_id,
      )
      .toArray();
    const now = Date.now();
    const snapshotId = crypto.randomUUID();
    const snapshotSeq = (latest?.seq ?? 0) + 1;
    const storageKey = `${tenantId}/${session.session_id}/snapshots/${String(snapshotSeq).padStart(8, "0")}-${snapshotId}`;
    sql.exec(
      "INSERT INTO snapshot_requests (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      snapshotId,
      session.session_id,
      session.box_id,
      turn.turn_id,
      snapshotSeq,
      storageKey,
      now,
    );
    const deadlineSeconds = settingsOf(this.env).snapshotDeadlineSeconds;
    const uploadUrl = await signerOf(
      this.env,
      this.env.R2_BUCKET_NAME,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    ).presign("PUT", storageKey, deadlineSeconds, new Date(now));
    await this.timers(tenantId, session.session_id, {
      SnapshotAnswer: { turnId: turn.turn_id, at: now + deadlineSeconds * 1000 },
    });
    await this.host(session.host_id).send({
      type: "SnapshotRequest",
      snapshotId,
      sessionId: session.session_id,
      boxId: session.box_id,
      turnId: turn.turn_id,
      snapshotSeq,
      storageKey,
      uploadUrl,
      uploadExpiresAt: iso(now + deadlineSeconds * 1000),
    });
  }

  private snapshotUnanswered(session: SessionRow, turn: TurnRow, failedAt: string): void {
    const sql = this.ctx.storage.sql;
    const requests = sql
      .exec<SnapshotRequestRow>(
        "SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key FROM snapshot_requests WHERE session_id = ? AND turn_id = ?",
        session.session_id,
        turn.turn_id,
      )
      .toArray();
    const seconds = settingsOf(this.env).snapshotDeadlineSeconds;
    for (const request of requests) {
      this.recordSnapshotFailure(
        request,
        "NotAnswered",
        `host ${session.host_id} did not answer snapshot ${request.snapshot_id} within ${seconds} seconds, and its upload URL has expired; check that its supervisor runs with tumpel host list`,
        failedAt,
      );
    }
    if (requests.length > 0 && session.state === "Stopping") this.returnToIdle(session.session_id);
  }

  private dropPlacements(snapshotId: string): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM snapshot_packs WHERE snapshot_id = ?", snapshotId);
    sql.exec("DELETE FROM snapshot_chunks WHERE snapshot_id = ?", snapshotId);
  }

  private promotePlacements(snapshotId: string, now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT OR IGNORE INTO packs (pack_digest, size_bytes, created_at) SELECT pack_digest, size_bytes, ?1 FROM snapshot_packs WHERE snapshot_id = ?2",
      now,
      snapshotId,
    );
    sql.exec(
      "INSERT OR IGNORE INTO chunks (digest, pack_digest, byte_offset, byte_length) SELECT digest, pack_digest, byte_offset, byte_length FROM snapshot_chunks WHERE snapshot_id = ?",
      snapshotId,
    );
    this.dropPlacements(snapshotId);
  }

  private async lateSnapshotDone(hostId: string, snapshotId: string): Promise<void> {
    const [failure] = this.ctx.storage.sql
      .exec<{ session_id: string; storage_key: string }>(
        "SELECT session_id, storage_key FROM snapshot_failures WHERE snapshot_id = ? AND reason = 'NotAnswered'",
        snapshotId,
      )
      .toArray();
    if (failure === undefined || this.sessionRow(failure.session_id)?.host_id !== hostId) return;
    if ((await this.env.STORE.head(failure.storage_key)) === null) return;
    this.ctx.storage.transactionSync(() => this.promotePlacements(snapshotId, Date.now()));
  }

  private recordSnapshotFailure(request: SnapshotRequestRow, reason: string, detail: string, failedAt: string): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM snapshot_requests WHERE snapshot_id = ?", request.snapshot_id);
      if (reason !== "NotAnswered") this.dropPlacements(request.snapshot_id);
      sql.exec(
        "INSERT INTO snapshot_failures (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, reason, detail, failed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        request.snapshot_id,
        request.session_id,
        request.box_id,
        request.turn_id,
        request.snapshot_seq,
        request.storage_key,
        reason,
        detail,
        failedAt,
        Date.now(),
      );
    });
  }

  private async snapshotAnswer(
    tenantId: string,
    hostId: string,
    message: Extract<HostMessage, { type: "SnapshotDone" | "SnapshotFailed" }>,
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    const [request] = sql
      .exec<SnapshotRequestRow>(
        "SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key FROM snapshot_requests WHERE snapshot_id = ?",
        message.snapshotId,
      )
      .toArray();
    if (request === undefined) {
      if (message.type === "SnapshotDone") await this.lateSnapshotDone(hostId, message.snapshotId);
      return;
    }
    const session = this.sessionRow(request.session_id);
    if (session?.host_id !== hostId) {
      throw new Error(
        `host ${hostId} answered snapshot ${message.snapshotId} of tenant ${tenantId}, which it was not asked for`,
      );
    }
    await this.timers(tenantId, request.session_id, { SnapshotAnswer: null });
    if (message.type === "SnapshotFailed") {
      this.recordSnapshotFailure(request, message.reason, message.detail, message.failedAt);
      if (session.state !== "Stopping") return;
      if (message.reason === "BoxNotFound") {
        return this.timers(tenantId, session.session_id, { Teardown: { turnId: request.turn_id, at: Date.now() } });
      }
      return this.returnToIdle(session.session_id);
    }
    if ((await this.env.STORE.head(request.storage_key)) === null) {
      this.recordSnapshotFailure(
        request,
        "UploadRejected",
        `host ${hostId} answered SnapshotDone, but object storage holds no root under ${request.storage_key}; check the host's uploads to object storage`,
        iso(Date.now()),
      );
      if (session.state === "Stopping") this.returnToIdle(session.session_id);
      return;
    }
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM snapshot_requests WHERE snapshot_id = ?", request.snapshot_id);
      this.promotePlacements(request.snapshot_id, now);
      sql.exec(
        "INSERT INTO snapshots (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        request.snapshot_id,
        request.session_id,
        request.box_id,
        request.turn_id,
        request.snapshot_seq,
        request.storage_key,
        message.uploadedBytes,
        now,
        now,
      );
    });
    if (session.state !== "Stopping") return;
    const latest = this.latestTurn(session.session_id, null);
    if (latest === null) throw new Error(`session ${session.session_id} has no turn, though a start always offers one`);
    await this.snapshotOrTeardown(tenantId, session, latest);
  }
}
