import { DurableObject } from "cloudflare:workers";
import {
  SessionSchema,
  type SessionStartSchema,
  SnapshotSchema,
  type StartedSessionSchema,
  TranscriptLineSchema,
  TurnFailureSchema,
  TurnSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import type { DispatchGrant, HostMessage, StoredControlMessage } from "./channel/protocol.ts";
import { catalogEntry } from "./harness-catalog";
import type { Env } from "./index";
import type { DeadlineChanges, DeadlineName } from "./session-timer";
import { settingsOf } from "./settings";
import { chunkKey, encodeChunk, type Range, rangeAfter, type TranscriptLine } from "./transcript";

export type Session = z.infer<typeof SessionSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type TurnFailure = z.infer<typeof TurnFailureSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type SessionStart = z.infer<typeof SessionStartSchema>;
export type StartedSession = z.infer<typeof StartedSessionSchema>;
type TurnFailureReason = TurnFailure["reason"];
type SessionState = Session["state"];

export interface NewSession {
  principalId: string;
  hostId: string;
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
  | { kind: "NoCredential"; secretSetId: string; keyName: string };

export type TranscriptCursor =
  | { kind: "Chunk"; sessionState: SessionState; storageKey: string; range: Range }
  | { kind: "Lines"; sessionState: SessionState; lines: TranscriptLine[] };

type SessionRow = {
  session_id: string;
  principal_id: string;
  host_id: string;
  box_id: string;
  secret_set_id: string;
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
  size_bytes: number;
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
  "SELECT session_id, principal_id, host_id, box_id, secret_set_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at FROM sessions";
const TURN_SELECT = "SELECT turn_id, session_id, box_id, prompt, state, line_count, created_at, updated_at FROM turns";
const SNAPSHOT_SELECT =
  "SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, created_at, updated_at FROM snapshots";

const IN_FLIGHT = ["Queued", "Offered", "Running"];

const toSession = (tenantId: string, row: SessionRow): Session =>
  SessionSchema.parse({
    sessionId: row.session_id,
    tenantId,
    principalId: row.principal_id,
    hostId: row.host_id,
    boxId: row.box_id,
    secretSetId: row.secret_set_id,
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
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

export class TenantSessions extends DurableObject<Env> {
  private sessionRow(sessionId: string): SessionRow | null {
    const [row] = this.ctx.storage.sql.exec<SessionRow>(`${SESSION_SELECT} WHERE session_id = ?`, sessionId).toArray();
    return row ?? null;
  }

  private turnRow(turnId: string): TurnRow | null {
    const [row] = this.ctx.storage.sql.exec<TurnRow>(`${TURN_SELECT} WHERE turn_id = ?`, turnId).toArray();
    return row ?? null;
  }

  private hasCredential(secretSetId: string, harness: string, harnessVersion: string): string | null {
    const entry = catalogEntry(harness, harnessVersion);
    if (entry === undefined) throw new Error(`${harness} ${harnessVersion} left the harness catalog`);
    const [row] = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM secret_values WHERE secret_set_id = ? AND name = ?",
        secretSetId,
        entry.providerKeyName,
      )
      .toArray();
    return row === undefined ? entry.providerKeyName : null;
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
      secret_set_id: start.secretSetId,
      persona_id: start.personaId,
      repository: start.repository,
      harness: start.harness,
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
        `INSERT INTO sessions (session_id, principal_id, host_id, box_id, secret_set_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        session.session_id,
        session.principal_id,
        session.host_id,
        session.box_id,
        session.secret_set_id,
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
    const [running] = this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        `SELECT turn_id FROM turns WHERE session_id = ? AND state IN (${IN_FLIGHT.map(() => "?").join(", ")})`,
        sessionId,
        ...IN_FLIGHT,
      )
      .toArray();
    if (running !== undefined) return { kind: "InFlight", turnId: running.turn_id };
    const missing = this.hasCredential(session.secret_set_id, session.harness, session.harness_version);
    if (missing !== null) return { kind: "NoCredential", secretSetId: session.secret_set_id, keyName: missing };
    const turn = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE sessions SET state = 'Running', updated_at = ? WHERE session_id = ?",
        now,
        sessionId,
      );
      return this.insertTurn(sessionId, session.box_id, prompt, now);
    });
    await this.offer(tenantId, session, turn);
    return { kind: "Sent", turn: toTurn(tenantId, turn) };
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

  listSnapshots(tenantId: string, sessionId: string): Snapshot[] | null {
    if (this.sessionRow(sessionId) === null) return null;
    return this.ctx.storage.sql
      .exec<SnapshotRow>(`${SNAPSHOT_SELECT} WHERE session_id = ? ORDER BY snapshot_seq`, sessionId)
      .toArray()
      .map((row) => toSnapshot(tenantId, row));
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

  mintGrant(tenantId: string, turnId: string, hostId: string, now: number): DispatchGrant {
    const turn = this.turnRow(turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null) {
      throw new Error(`host ${hostId} has an offer for turn ${turnId}, which tenant ${tenantId} does not hold`);
    }
    const entry = catalogEntry(session.harness, session.harness_version);
    if (entry === undefined) {
      throw new Error(
        `session ${session.session_id} runs ${session.harness} ${session.harness_version}, which left the catalog`,
      );
    }
    const [secret] = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM secret_values WHERE secret_set_id = ? AND name = ?",
        session.secret_set_id,
        entry.providerKeyName,
      )
      .toArray();
    if (secret === undefined) {
      throw new Error(
        `secret set ${session.secret_set_id} has no ${entry.providerKeyName} for turn ${turnId}; add it with tumpel config apply`,
      );
    }
    const dispatchCredentialId = crypto.randomUUID();
    const expiresAt = iso(now + settingsOf(this.env).dispatchGrantTtlSeconds * 1000);
    this.ctx.storage.sql.exec(
      "INSERT INTO dispatch_credentials (dispatch_credential_id, turn_id, secret_set_id, host_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      dispatchCredentialId,
      turnId,
      session.secret_set_id,
      hostId,
      expiresAt,
      now,
    );
    return { dispatchCredentialId, expiresAt, variables: [{ name: entry.providerKeyName, value: secret.value }] };
  }

  async hostMessage(tenantId: string, hostId: string, message: HostMessage): Promise<void> {
    if (message.type === "SnapshotDone" || message.type === "SnapshotFailed") {
      return this.snapshotAnswer(tenantId, hostId, message);
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
      const settings = settingsOf(this.env);
      this.ctx.storage.transactionSync(() => {
        sql.exec("UPDATE turns SET state = 'Running', updated_at = ? WHERE turn_id = ?", now, turn.turn_id);
        sql.exec("UPDATE sessions SET state = 'Running', updated_at = ? WHERE session_id = ?", now, session.session_id);
      });
      return this.timers(tenantId, session.session_id, {
        Claim: null,
        FirstLine: { turnId: turn.turn_id, at: now + settings.turnFirstLineBudgetSeconds * 1000 },
      });
    }
    if (message.type === "TurnFailed") {
      return this.failTurn(tenantId, turn.turn_id, message.reason, message.detail, message.failedAt);
    }
    if (turn.state !== "Running") return;
    if (message.type === "TurnLine")
      return this.appendLine(tenantId, session, turn, message.lineSeq, message.text, now);
    await this.flush(tenantId, session.session_id, turn.turn_id);
    this.ctx.storage.transactionSync(() => {
      sql.exec("UPDATE turns SET state = 'Completed', updated_at = ? WHERE turn_id = ?", now, turn.turn_id);
      sql.exec("UPDATE sessions SET state = 'Idle', updated_at = ? WHERE session_id = ?", now, session.session_id);
    });
    await this.timers(tenantId, session.session_id, {
      Claim: null,
      FirstLine: null,
      Total: null,
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
        `the harness wrote no line for turn ${turnId} within ${settings.turnFirstLineBudgetSeconds} seconds of its claim; check the box on host ${session.host_id}, then send the turn again`,
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
    await this.timers(tenantId, turn.session_id, { Claim: null, FirstLine: null, Total: null });
  }

  private async requestSnapshot(tenantId: string, session: SessionRow, turn: TurnRow): Promise<void> {
    if (session.state !== "Idle") return;
    const sql = this.ctx.storage.sql;
    const [latest] = sql
      .exec<{ seq: number | null }>(
        "SELECT MAX(seq) AS seq FROM (SELECT snapshot_seq AS seq FROM snapshots WHERE session_id = ?1 UNION ALL SELECT snapshot_seq FROM snapshot_requests WHERE session_id = ?1)",
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
    await this.host(session.host_id).send({
      type: "SnapshotRequest",
      snapshotId,
      sessionId: session.session_id,
      boxId: session.box_id,
      turnId: turn.turn_id,
      snapshotSeq,
      storageKey,
      uploadUrl: `${session.endpoint}/v1/snapshots/${snapshotId}/content`,
      uploadExpiresAt: iso(now + settingsOf(this.env).dispatchGrantTtlSeconds * 1000),
    });
  }

  private snapshotAnswer(
    tenantId: string,
    hostId: string,
    message: Extract<HostMessage, { type: "SnapshotDone" | "SnapshotFailed" }>,
  ): void {
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
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM snapshot_requests WHERE snapshot_id = ?", request.snapshot_id);
      if (message.type === "SnapshotFailed") {
        sql.exec(
          "INSERT INTO snapshot_failures (snapshot_id, session_id, turn_id, snapshot_seq, reason, detail, failed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          request.snapshot_id,
          request.session_id,
          request.turn_id,
          request.snapshot_seq,
          message.reason,
          message.detail,
          message.failedAt,
          now,
        );
        return;
      }
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
  }
}
