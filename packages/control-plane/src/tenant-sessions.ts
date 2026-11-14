import { DurableObject } from "cloudflare:workers";
import {
  CredentialHandoverSchema,
  type RepositoryCloneFailureCauseSchema,
  SecretSetCreateSchema,
  SecretSetSchema,
  SessionSchema,
  type SessionStartSchema,
  SnapshotSchema,
  type StartedSessionSchema,
  StopFailureSchema,
  TranscriptLineSchema,
  TurnFailureSchema,
  TurnSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import {
  HEARTBEAT_DEADLINE_MS,
  type HostMessage,
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
import { catalogEntry } from "./harness-catalog";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import { personaFileKey } from "./persona-files";
import { signerOf } from "./presign";
import type { DeadlineChanges, DeadlineName } from "./session-timer";
import { settingsOf } from "./settings";
import { chunkKey, encodeChunk, type Range, rangeAfter, type TranscriptLine } from "./transcript";

export type Session = z.infer<typeof SessionSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type TurnFailure = z.infer<typeof TurnFailureSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type CredentialHandover = z.infer<typeof CredentialHandoverSchema>;
export type SessionStart = z.infer<typeof SessionStartSchema>;
export type StartedSession = z.infer<typeof StartedSessionSchema>;
type TurnFailureReason = TurnFailure["reason"];
type SessionState = Session["state"];
export type StopFailure = z.infer<typeof StopFailureSchema>;

export interface NewSession {
  principalId: string;
  hostId: string;
  harness: Session["harness"];
  harnessVersion: string;
  endpoint: string;
  start: SessionStart;
}

export interface SessionFilter {
  state?: SessionState;
  hostId?: string;
}

export type Sent =
  | { kind: "Sent"; turn: Turn }
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

export type TranscriptCursor =
  | { kind: "Chunk"; sessionState: SessionState; storageKey: string; range: Range }
  | { kind: "Lines"; sessionState: SessionState; lines: TranscriptLine[] };

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

type TurnRow = {
  turn_id: string;
  session_id: string;
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
const TURN_SELECT = "SELECT turn_id, session_id, box_id, prompt, state, line_count, created_at, updated_at FROM turns";
const SNAPSHOT_SELECT = `SELECT * FROM (
  SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, NULL AS reason, NULL AS detail, NULL AS failed_at, created_at, updated_at FROM snapshots
  UNION ALL
  SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, NULL, reason, detail, failed_at, created_at, created_at FROM snapshot_failures
)`;

const IN_FLIGHT = ["Offered", "Running"];
const STORE_DELETE_BATCH = 1000;

const toSession = (tenantId: string, row: SessionRow): Session =>
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
        : { state: "Stored", sizeBytes: row.size_bytes },
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

  private personaRow(personaId: string): { secretSetId: string; gitAuthorName: string; gitAuthorEmail: string } | null {
    const [row] = this.ctx.storage.sql
      .exec<{ secret_set_id: string; git_author_name: string; git_author_email: string }>(
        "SELECT secret_set_id, git_author_name, git_author_email FROM personas WHERE persona_id = ?",
        personaId,
      )
      .toArray();
    return row === undefined
      ? null
      : { secretSetId: row.secret_set_id, gitAuthorName: row.git_author_name, gitAuthorEmail: row.git_author_email };
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

  private cloneFailureDetail(
    session: SessionRow,
    turnId: string,
    cause: z.infer<typeof RepositoryCloneFailureCauseSchema>,
    hostDetail: string,
  ): string {
    const name = this.secretSetName(session);
    const [handover] = this.ctx.storage.sql
      .exec<{ variable_names: string }>(
        "SELECT variable_names FROM credential_handovers WHERE turn_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        turnId,
      )
      .toArray();
    if (handover === undefined) {
      throw new Error(
        `host ${session.host_id} reported a clone failure for turn ${turnId}, which no credential was handed over for`,
      );
    }
    const names = CredentialHandoverSchema.shape.variableNames.parse(JSON.parse(handover.variable_names));
    if (cause !== "Refused" || names.includes("GITHUB_TOKEN")) {
      return `${hostDetail}. The persona runs on secret set ${name}`;
    }
    return `${hostDetail}. A private repository needs a Variable member GITHUB_TOKEN with read and write access in secret set ${name}; add it with tumpel config apply, then send the turn again`;
  }

  private refusedSetDetail(session: SessionRow, hostDetail: string): string {
    const name = this.secretSetName(session);
    return `${hostDetail}. The credential comes from secret set ${name}; replace its value with tumpel config apply --rewrite-secrets ${name}, then send the turn again`;
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

  private async members(secretSetId: string): Promise<SecretMember[]> {
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

  private timers(tenantId: string, sessionId: string, changes: DeadlineChanges): Promise<void> {
    return this.env.SESSION_TIMER.getByName(sessionId).set(tenantId, sessionId, changes);
  }

  private host(hostId: string) {
    return this.env.HOST.get(this.env.HOST.idFromName(hostId));
  }

  private async offer(tenantId: string, session: SessionRow, turn: TurnRow): Promise<void> {
    const settings = settingsOf(this.env);
    const now = Date.now();
    await this.timers(tenantId, session.session_id, {
      Claim: { turnId: turn.turn_id, at: now + settings.turnClaimBudgetSeconds * 1000 },
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

  private insertTurn(sessionId: string, boxId: string, prompt: string, now: number): TurnRow {
    const turn: TurnRow = {
      turn_id: crypto.randomUUID(),
      session_id: sessionId,
      box_id: boxId,
      prompt,
      state: "Offered",
      line_count: 0,
      created_at: now,
      updated_at: now,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO turns (turn_id, session_id, box_id, prompt, state, line_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      turn.turn_id,
      turn.session_id,
      turn.box_id,
      turn.prompt,
      turn.state,
      turn.line_count,
      turn.created_at,
      turn.updated_at,
    );
    return turn;
  }

  async startSession(tenantId: string, input: NewSession, now: number): Promise<StartedSession> {
    const { start } = input;
    const session: SessionRow = {
      session_id: crypto.randomUUID(),
      principal_id: input.principalId,
      host_id: input.hostId,
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
      return this.insertTurn(session.session_id, session.box_id, start.prompt, now);
    });
    await this.offer(tenantId, session, turn);
    return { session: toSession(tenantId, session), turn: toTurn(tenantId, turn) };
  }

  async sendTurn(tenantId: string, sessionId: string, prompt: string, now: number): Promise<Sent> {
    const session = this.sessionRow(sessionId);
    if (session === null) return { kind: "NotFound" };
    if (session.state === "Archived") return { kind: "Archived" };
    if (session.state === "Stopping") return { kind: "Stopping" };
    const running = this.inFlightTurn(sessionId);
    if (running !== null) return { kind: "InFlight", turnId: running };
    const refusal = this.refusedCredential(session, now);
    if (refusal !== null) return { kind: "CredentialRefused", personaId: session.persona_id, refusal };
    const boxId = session.state === "Stopped" ? crypto.randomUUID() : session.box_id;
    const turn = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE sessions SET state = 'Running', box_id = ?, updated_at = ? WHERE session_id = ?",
        boxId,
        now,
        sessionId,
      );
      return this.insertTurn(sessionId, boxId, prompt, now);
    });
    await this.offer(tenantId, { ...session, box_id: boxId }, turn);
    return { kind: "Sent", turn: toTurn(tenantId, turn) };
  }

  async stopSession(tenantId: string, sessionId: string, now: number): Promise<Stop> {
    const session = this.sessionRow(sessionId);
    if (session === null) return { kind: "NotFound" };
    if (session.state === "Archived") return { kind: "Archived" };
    if (session.state === "Stopping" || session.state === "Stopped") {
      return { kind: "Stopping", session: toSession(tenantId, session) };
    }
    const running = this.inFlightTurn(sessionId);
    if (running !== null) return { kind: "InFlight", turnId: running };
    const latest = this.latestTurn(sessionId, null);
    if (latest === null) throw new Error(`session ${sessionId} has no turn, though a start always offers one`);
    this.setSessionState(sessionId, "Stopping", now);
    await this.timers(tenantId, sessionId, { Snapshot: null });
    const stopping = { ...session, state: "Stopping", updated_at: now };
    await this.snapshotOrTeardown(tenantId, stopping, latest);
    return { kind: "Stopping", session: toSession(tenantId, stopping) };
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
    for (let start = 0; start < keys.length; start += STORE_DELETE_BATCH) {
      await this.env.STORE.delete(keys.slice(start, start + STORE_DELETE_BATCH));
    }
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM snapshots WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM snapshot_failures WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM snapshot_requests WHERE session_id = ?", sessionId);
    });
    await this.timers(tenantId, sessionId, {
      Claim: null,
      FirstLine: null,
      Total: null,
      Snapshot: null,
      SnapshotAnswer: null,
      Teardown: null,
      TeardownAnswer: null,
      HostOffline: null,
    });
    const archived = this.sessionRow(sessionId);
    if (archived === null) throw new Error(`session ${sessionId} vanished while it was archived`);
    return { kind: "Archived", session: toSession(tenantId, archived) };
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
    if (session?.host_id !== hostId) {
      throw new Error(
        `host ${hostId} answered the teardown of session ${message.sessionId} of tenant ${tenantId}, which it was not asked for`,
      );
    }
    if (session.state !== "Stopping") return;
    await this.timers(tenantId, session.session_id, { TeardownAnswer: null });
    if (message.type === "BoxGone") return this.setSessionState(session.session_id, "Stopped", Date.now());
    this.recordStopFailure(session.session_id, message.reason, message.detail, message.failedAt);
    this.returnToIdle(session.session_id);
    return this.rearmSnapshot(tenantId, session.session_id);
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
    const row = this.sessionRow(sessionId);
    return row === null ? null : toSession(tenantId, row);
  }

  listSessions(tenantId: string, filter: SessionFilter): Session[] {
    return this.ctx.storage.sql
      .exec<SessionRow>(
        `${SESSION_SELECT} WHERE (?1 IS NULL OR state = ?1) AND (?2 IS NULL OR host_id = ?2) ORDER BY created_at, session_id`,
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
          credential_handovers.host_id, turns.box_id, credential_handovers.variable_names, credential_handovers.created_at
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
  ): TranscriptCursor | null {
    const session = this.sessionRow(sessionId);
    if (session === null) return null;
    const sessionState = SessionSchema.shape.state.parse(session.state);
    const sql = this.ctx.storage.sql;
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
      const range = rangeAfter(JSON.parse(chunk.line_seqs), JSON.parse(chunk.offsets), after, limit);
      if (range === null) throw new Error(`transcript chunk ${chunk.storage_key} holds no line after ${after}`);
      return { kind: "Chunk", sessionState, storageKey: chunk.storage_key, range };
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
    return { kind: "Lines", sessionState, lines };
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
    const { secretSetId, gitAuthorName, gitAuthorEmail } = persona;
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
        `subscription token ${dispatch.name} of secret set ${secretSetId} expired at ${dispatch.expiresAt}; write a fresh token and its expiresAt with tumpel config apply --rewrite-secrets, then send the turn again`,
        iso(now),
      );
      return { kind: "Withdrawn" };
    }
    const settings = settingsOf(this.env);
    const handover = {
      credentialHandoverId: crypto.randomUUID(),
      turnId,
      hostId,
      variableNames: dispatch.variables.map((variable) => variable.name),
      createdAt: now,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO credential_handovers (credential_handover_id, turn_id, host_id, variable_names, created_at) VALUES (?, ?, ?, ?, ?)",
      handover.credentialHandoverId,
      handover.turnId,
      handover.hostId,
      JSON.stringify(handover.variableNames),
      handover.createdAt,
    );
    const stored = this.ctx.storage.sql
      .exec<{ snapshot_id: string; snapshot_seq: number; storage_key: string }>(
        "SELECT snapshot_id, snapshot_seq, storage_key FROM snapshots WHERE session_id = ? ORDER BY snapshot_seq",
        session.session_id,
      )
      .toArray();
    const snapshots = await this.downloads(stored, settings.turnClaimBudgetSeconds, now);
    const personaFiles = await this.personaFiles(tenantId, session.persona_id, settings.turnClaimBudgetSeconds, now);
    return {
      kind: "Ready",
      credential: {
        credentialHandoverId: handover.credentialHandoverId,
        expiresAt: iso(now + settings.dispatchGrantTtlSeconds * 1000),
        variables: dispatch.variables,
      },
      lastLineSeq: session.last_line_seq,
      snapshots,
      personaFiles,
      gitAuthorName,
      gitAuthorEmail,
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
    const signer = signerOf(this.env);
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
    const signer = signerOf(this.env);
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
        `SELECT turns.session_id, turns.turn_id FROM turns JOIN sessions ON sessions.session_id = turns.session_id
        WHERE sessions.host_id = ? AND turns.state IN (${IN_FLIGHT.map(() => "?").join(", ")})`,
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

  async hostMessage(tenantId: string, hostId: string, message: HostMessage): Promise<void> {
    if (message.type === "SnapshotDone" || message.type === "SnapshotFailed") {
      return this.snapshotAnswer(tenantId, hostId, message);
    }
    if (message.type === "BoxGone" || message.type === "BoxTeardownFailed") {
      return this.teardownAnswer(tenantId, hostId, message);
    }
    const turn = this.turnRow(message.turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null || session.host_id !== hostId) {
      throw new Error(`host ${hostId} sent ${message.type} for turn ${message.turnId}, which is not offered to it`);
    }
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    if (message.type === "TurnClaim") {
      if (turn.state !== "Offered") return;
      this.ctx.storage.transactionSync(() => {
        sql.exec("UPDATE turns SET state = 'Running', updated_at = ? WHERE turn_id = ?", now, turn.turn_id);
        sql.exec("UPDATE sessions SET state = 'Running', updated_at = ? WHERE session_id = ?", now, session.session_id);
      });
      const settings = settingsOf(this.env);
      return this.timers(tenantId, session.session_id, {
        Claim: null,
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
      const detail = this.cloneFailureDetail(session, turn.turn_id, message.cause, message.detail);
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
      FirstLine: null,
      Total: null,
      HostOffline: null,
      Snapshot: { turnId: turn.turn_id, at: now + settingsOf(this.env).snapshotDelaySeconds * 1000 },
    });
  }

  async deadlineReached(tenantId: string, sessionId: string, name: DeadlineName, turnId: string): Promise<void> {
    const turn = this.turnRow(turnId);
    const session = this.sessionRow(sessionId);
    if (turn === null || session === null) return;
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
    await this.timers(tenantId, turn.session_id, { Claim: null, FirstLine: null, Total: null, HostOffline: null });
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
    const uploadUrl = await signerOf(this.env).presign("PUT", storageKey, deadlineSeconds, new Date(now));
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

  private recordSnapshotFailure(request: SnapshotRequestRow, reason: string, detail: string, failedAt: string): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM snapshot_requests WHERE snapshot_id = ?", request.snapshot_id);
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
    if (request === undefined) return;
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
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM snapshot_requests WHERE snapshot_id = ?", request.snapshot_id);
      sql.exec(
        "INSERT INTO snapshots (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        request.snapshot_id,
        request.session_id,
        request.box_id,
        request.turn_id,
        request.snapshot_seq,
        request.storage_key,
        message.sizeBytes,
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
