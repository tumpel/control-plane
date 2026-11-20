import { DurableObject } from "cloudflare:workers";
import { MCP_PATH } from "@tumpel/api/constants";
import {
  type CredentialRefusal,
  checkModelCredential,
  credentialProblem,
  dispatchVariables,
  type SecretMember,
} from "@tumpel/api/credentials";
import type { BoxRetentionSchema, ServeConnectorTokenResultSchema } from "@tumpel/schemas";
import {
  CredentialHandoverSchema,
  HarnessSchema,
  type PatchSessionTagsResultSchema,
  type PrebuildFailurePhaseSchema,
  type SessionFilterSchema,
  type SessionIssueSchema,
  SessionPrebuildLayerSchema,
  SessionSchema,
  type SessionStartSchema,
  type SessionTagsPatchSchema,
  type SetSessionTagsResultSchema,
  SnapshotManifestSchema,
  SnapshotRootSchema,
  SnapshotSchema,
  type StartedSessionFromIssueSchema,
  type StartedSessionSchema,
  type SteerSchema,
  StopFailureSchema,
  TranscriptLineSchema,
  TurnFailureSchema,
  TurnImageSchema,
  TurnSchema,
  type TurnSendSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { CONNECTORS_VERSION, TURN_CANCEL_VERSION } from "./channel/control.ts";
import type {
  BootImage,
  DispatchConnector,
  HostMessage,
  HostUsage,
  PersonaFileDownload,
  PreparedOffer,
  SnapshotDownload,
  StoredControlMessage,
} from "./channel/protocol.ts";
import { successResultOf } from "./compact.ts";
import { TURN_TOKEN_PURPOSE, turnToken } from "./connector-oauth.ts";
import {
  copyPersonaConnectors,
  DISCONNECTED_FIX,
  disconnectedDetail,
  personaConnectorUses,
  releaseConnectorCredentials,
  sessionConnectorUses,
} from "./connector-rows.ts";
import { accessTokenExpiry } from "./credential-file.ts";
import { deployDraining, type RunningTurns } from "./deploy-drain";
import { generateDataKey, seal, unseal } from "./envelope.ts";
import {
  AGENT_SCOPE,
  botLogin,
  botUserId,
  CONTENTS_READ,
  type CommitIdentity,
  commitIdentity,
  type GitHubAnswer,
  type GitHubRepository,
  githubRepository,
  type Minted,
  mintInstallationToken,
  mintOwnerTokens,
  type OwnerToken,
  parseJson,
  REPOSITORY_TOKEN,
  type RepositoryCredentialSource,
  repositoryCredential,
  type TokenScope,
  uncovered,
  withOwnerTokens,
} from "./github.ts";
import { appKey, installationOn, installationsOf, storeBotUserId, storedApp } from "./github-store.ts";
import { catalogEntry, GOAL_FOLDS, GOAL_TURN_CAP } from "./harness-catalog";
import { type HostRecord, hostOf, listHosts } from "./hosts";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import { recordObjectCleanups } from "./object-cleanups.ts";
import { personaFileKey, sha256Hex } from "./persona-files";
import {
  type BoxSize,
  type HeldBox,
  type ImageAvailability,
  placeSession,
  type ReportedHostUsage,
  type Unplaceable,
} from "./placement";
import { signerOf } from "./presign";
import { bootArchitectures, bootFor, bootImage, type ReleaseRead, readRelease } from "./releases";
import { type MemberRow, storedKeys, toMember } from "./secret-members.ts";
import type { DeadlineChanges, SessionDueDeadline } from "./session-timer";
import { why } from "./sessions.ts";
import { settingsOf, turnCredentialSeconds } from "./settings";
import { STEER_CONNECTOR_ID, STEER_SETTINGS_PATH, steerSettings } from "./steer.ts";
import {
  clearSupersededFailure,
  forgetSupervisorUpdates,
  restartDeadline,
  type SupervisorUpdateMessage,
} from "./supervisor-updates";
import { appendEvent, type NewTenantEvent } from "./tenant-events.ts";
import { ChunkWriter, linesWithin, type Range, rangeAfter, type TranscriptLine } from "./transcript";
import {
  type Dimensions,
  DimensionsSchema,
  offeredDimensions,
  type TimingMetric,
  timingBatch,
} from "./turn-metrics.ts";
import { mintTurnToken, TUMPEL_CONNECTOR_ID, TURN_TOKEN_SIGNING_PURPOSE } from "./turn-token.ts";

export type Session = z.infer<typeof SessionSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type TurnSend = z.infer<typeof TurnSendSchema>;
export type TurnFailure = z.infer<typeof TurnFailureSchema>;
type SessionPrebuildLayer = z.infer<typeof SessionPrebuildLayerSchema>;
type TurnImage = z.infer<typeof TurnImageSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type CredentialHandover = z.infer<typeof CredentialHandoverSchema>;
export type SessionStart = z.infer<typeof SessionStartSchema>;
export type StartedSession = z.infer<typeof StartedSessionSchema>;
export type StartedSessionFromIssue = z.infer<typeof StartedSessionFromIssueSchema>;
type BoxRetention = z.infer<typeof BoxRetentionSchema>;
type ConnectorTokenServed = z.infer<typeof ServeConnectorTokenResultSchema>["served"];
export type SessionIssue = z.infer<typeof SessionIssueSchema>;
export type IssueOfSession = Omit<SessionIssue, "sessionId">;
type TurnFailureReason = TurnFailure["reason"];
type SessionState = Session["state"];
export type StopFailure = z.infer<typeof StopFailureSchema>;
type IdentityAnswer = { kind: "Identity"; identity: CommitIdentity } | { kind: "Refused"; detail: string };

export interface NewSession {
  principalId: string;
  startedBy: Session["startedBy"];
  hosts: HostRecord[];
  harness: Session["harness"];
  harnessVersion: string;
  endpoint: string;
  start: SessionStart;
}

export type SessionFilter = z.infer<typeof SessionFilterSchema>;
type SessionStartedBy = Session["startedBy"];
type SessionTagsPatch = z.infer<typeof SessionTagsPatchSchema>;
type SetTags = z.infer<typeof SetSessionTagsResultSchema>["tagged"];
type PatchTags = z.infer<typeof PatchSessionTagsResultSchema>["tagged"];

export const SESSION_TAG_LIMIT = 16;

export type ReleaseUnreadable = { kind: "ReleaseUnreadable"; detail: string };

export interface FailureReport {
  phase: z.infer<typeof PrebuildFailurePhaseSchema>;
  detail: string;
  fix: string;
}

export const PREBUILD_ARCHITECTURE = "Amd64";

export type Started<T> =
  | { kind: "Started"; started: T }
  | { kind: "Draining" }
  | { kind: "Unplaced"; hosts: Unplaceable[] }
  | { kind: "ConnectorDisconnected"; names: string[] }
  | ReleaseUnreadable;

export type SessionStarted<T> = Started<T> | { kind: "TagsOverLimit"; tags: string[] };

type ImageLookup = { kind: "Read"; image: ImageAvailability } | ReleaseUnreadable;

export type Sent =
  | { kind: "Sent"; turn: Turn }
  | { kind: "Draining" }
  | { kind: "Stranded"; missingTurnIds: string[] }
  | { kind: "Unplaced"; hosts: Unplaceable[] }
  | { kind: "ConnectorDisconnected"; names: string[] }
  | ReleaseUnreadable
  | { kind: "NotFound" }
  | { kind: "Stopping" }
  | { kind: "Archived" }
  | { kind: "Failed" }
  | { kind: "CredentialRefused"; personaId: string; refusal: CredentialRefusal };

type Steer = z.infer<typeof SteerSchema>;
type SteerState = Steer["state"];
export type SteerSent =
  | { kind: "Sent"; steer: Steer }
  | { kind: "NotFound" }
  | { kind: "NotRunning"; state: Turn["state"] }
  | { kind: "Unsupported" };
export type SteersTaken = { kind: "Taken"; prompts: string[] } | { kind: "Closed" };

export type CancelTurn =
  | { kind: "Cancelled"; turn: Turn }
  | { kind: "NotFound" }
  | { kind: "NotWaiting"; state: Turn["state"] };

export type Stop =
  | { kind: "Stopping"; session: Session }
  | { kind: "NotFound" }
  | { kind: "InFlight"; turnId: string }
  | { kind: "CancelUnspoken"; turnId: string; host: string }
  | { kind: "Archived" };

export type WaitedTurns = { kind: "Read"; turns: Turn[] } | { kind: "NotFound"; turnId: string };

export type Archive =
  | { kind: "Archived"; session: Session }
  | { kind: "NotFound" }
  | { kind: "NotStopped"; state: SessionState };

export type SessionDeleted = { kind: "Deleted" } | Exclude<Archive, { kind: "Archived" }>;

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
  box_memory_mib: number;
  box_disk_mib: number;
  box_retention: BoxRetention;
  created_at: number;
  updated_at: number;
};

type SessionViewRow = SessionRow & {
  last_turn_id: string;
  last_turn_host_id: string;
  last_turn_box_id: string;
  last_turn_prompt: string;
  last_turn_goal: string | null;
  last_turn_warning: string | null;
  last_turn_state: string;
  last_turn_line_count: number;
  last_turn_created_at: number;
  last_turn_at: number;
  last_turn_reason: string | null;
  last_turn_detail: string | null;
  last_turn_failed_at: string | null;
  issue_number: number | null;
  issue_title: string | null;
  issue_html_url: string | null;
  issue_branch: string | null;
  tags: string;
  origin_session_id: string | null;
  origin_turn_id: string | null;
};

type PersonaRow = {
  secretSetId: string;
  boxMemoryMib: number;
  boxDiskMib: number;
  boxRetention: BoxRetention;
  tumpelMcp: boolean;
};

export type TurnRow = {
  turn_id: string;
  session_id: string;
  host_id: string;
  box_id: string;
  prompt: string;
  goal: string | null;
  warning: string | null;
  state: string;
  line_count: number;
  created_at: number;
  updated_at: number;
  reason: string | null;
  detail: string | null;
  failed_at: string | null;
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
  channel_protocol: number;
  disk_budget_mib: number | null;
  disk_held_mib: number | null;
  memory_budget_mib: number | null;
  memory_held_mib: number | null;
  unreported_mib: number;
  created_at: number;
  updated_at: number;
};

type HostPrebuildRow = {
  prebuild_id: string;
  head_sha: string;
  log_url: string;
};

type StoredSnapshotRow = { snapshot_id: string; snapshot_seq: number; storage_key: string };

type LayerRow = {
  prebuild_id: string | null;
  layer_digest: string | null;
  reason: string | null;
  detail: string | null;
};

type ImageRow = { kind: string; digest: string; harness_layer_digest: string | null };

type LayerAbsence = Extract<SessionPrebuildLayer, { layer: "None" }>;

type LayerRecord = { layer: "Prebuild"; prebuildId: string } | LayerAbsence;

type PrebuildLayer = { record: LayerRecord; restored: StoredSnapshotRow[] };

type SnapshotRequestRow = {
  snapshot_id: string;
  session_id: string;
  box_id: string;
  turn_id: string;
  snapshot_seq: number;
  storage_key: string;
};

const SESSION_SELECT =
  "SELECT session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, COALESCE((SELECT box_memory_mib FROM session_box_memory WHERE session_box_memory.session_id = sessions.session_id), box_memory_mib) AS box_memory_mib, box_disk_mib, COALESCE((SELECT box_retention FROM session_box_retention WHERE session_box_retention.session_id = sessions.session_id), 'Auto') AS box_retention, created_at, updated_at FROM sessions";
const TURN_SELECT = `SELECT * FROM (
  SELECT turn_id, turns.session_id, host_id, box_id, prompt, (SELECT goal FROM turn_goals WHERE turn_goals.turn_id = turns.turn_id) AS goal, (SELECT warning FROM turn_warnings WHERE turn_warnings.turn_id = turns.turn_id) AS warning, state, line_count, turns.created_at, updated_at, reason, detail, failed_at
  FROM turns LEFT JOIN turn_failures USING (turn_id)
)`;
const SESSION_VIEW_SELECT = `SELECT s.session_id, s.principal_id, s.host_id, s.box_id, s.persona_id, s.repository, s.harness, s.harness_version, s.model, s.state, s.last_line_seq, s.endpoint, COALESCE(m.box_memory_mib, s.box_memory_mib) AS box_memory_mib, s.box_disk_mib, COALESCE(r.box_retention, 'Auto') AS box_retention, s.created_at, s.updated_at,
  t.turn_id AS last_turn_id, t.host_id AS last_turn_host_id, t.box_id AS last_turn_box_id, t.prompt AS last_turn_prompt, t.goal AS last_turn_goal, t.warning AS last_turn_warning, t.state AS last_turn_state,
  t.line_count AS last_turn_line_count, t.created_at AS last_turn_created_at, t.updated_at AS last_turn_at,
  t.reason AS last_turn_reason, t.detail AS last_turn_detail, t.failed_at AS last_turn_failed_at,
  i.issue_number, i.title AS issue_title, i.html_url AS issue_html_url, i.branch AS issue_branch,
  (SELECT json_group_array(tag) FROM session_tags WHERE session_tags.session_id = s.session_id) AS tags,
  o.origin_session_id, o.origin_turn_id
  FROM sessions AS s
  JOIN (${TURN_SELECT}) AS t ON t.turn_id = (SELECT turn_id FROM turns WHERE session_id = s.session_id ORDER BY created_at DESC, turn_id DESC LIMIT 1)
  LEFT JOIN session_issues AS i ON i.session_id = s.session_id
  LEFT JOIN session_box_memory AS m ON m.session_id = s.session_id
  LEFT JOIN session_box_retention AS r ON r.session_id = s.session_id
  LEFT JOIN session_origins AS o ON o.session_id = s.session_id`;
const SNAPSHOT_SELECT = `SELECT * FROM (
  SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, NULL AS reason, NULL AS detail, NULL AS failed_at, created_at, updated_at FROM snapshots
  UNION ALL
  SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, NULL, reason, detail, failed_at, created_at, created_at FROM snapshot_failures
)`;

const IN_FLIGHT = ["Offered", "Running"];
const PREBUILD_FIX = "Fix what the detail names, then start the prebuild again with rebuild set";
const STORE_DELETE_BATCH = 1000;

export type TenantHostMessage = Exclude<HostMessage, SupervisorUpdateMessage | { type: "TelemetryBatch" }>;
export type SessionHostMessage = Exclude<TenantHostMessage, { type: "ClaudeSetupBoxUrl" | "ClaudeSetupBoxFailed" }>;
type ChunkAsk = Extract<SessionHostMessage, { type: "SnapshotChunks" | "SnapshotPacks" | "RestoreChunks" }>;
type CloneFailed = Extract<SessionHostMessage, { type: "TurnRepositoryCloneFailed" }>;
type TurnFailed = Extract<SessionHostMessage, { type: "TurnFailed" }>;
type TurnClaim = Extract<SessionHostMessage, { type: "TurnClaim" }>;
type HostEvent = Exclude<
  SessionHostMessage,
  ChunkAsk | CloneFailed | TurnFailed | TurnClaim | { type: "SnapshotDone" | "SnapshotFailed" }
>;
type TurnEvent = Exclude<HostEvent, { type: "BoxGone" | "BoxTeardownFailed" }>;
type ChunkReply = Extract<
  StoredControlMessage,
  { type: "SnapshotChunksHeld" | "SnapshotPackUploads" | "RestoreDownloads" }
>;
type StoredTurnOffer = Extract<StoredControlMessage, { type: "TurnOffer" }>;
export type TurnHandoff = { type: "TurnHandoff"; hostId: string; offer: StoredTurnOffer };
export type Refused = { type: "Refused"; reason: string };
type OfferedTurn = { type: "Offered"; turn: TurnRow; session: SessionRow };
export type HostReply =
  | Refused
  | ChunkReply
  | Extract<StoredControlMessage, { type: "BoxDiscard" | "ClaudeSetupBoxDiscard" | "TurnClaimed" | "TurnWithdrawn" }>
  | StoredTurnOffer
  | TurnHandoff;

const refused = (reason: string): Refused => ({ type: "Refused", reason });

const packKey = (tenantId: string, packDigest: string): string => `${tenantId}/packs/${packDigest}`;

const DEAD_PACKS = "FROM packs WHERE NOT EXISTS (SELECT 1 FROM chunks WHERE chunks.pack_digest = packs.pack_digest)";

const ORPHAN_CHUNKS = `SELECT digest FROM session_chunks AS own WHERE own.session_id = ?1
  AND NOT EXISTS (SELECT 1 FROM session_chunks AS other WHERE other.digest = own.digest AND other.session_id != ?1)`;

const CHUNK_GRACE_MS = 24 * 60 * 60 * 1000;

const LIVE_CHUNKS =
  "SELECT digest FROM snapshot_manifest_chunks UNION SELECT digest FROM snapshot_chunks UNION SELECT digest FROM session_chunks";

const toSession = (
  tenantId: string,
  row: SessionViewRow,
  lastTurnImage: TurnImage | null,
  prebuildLayer: SessionPrebuildLayer | null,
): Session =>
  SessionSchema.parse({
    sessionId: row.session_id,
    tenantId,
    principalId: row.principal_id,
    startedBy:
      row.origin_session_id === null
        ? { kind: "Person", principalId: row.principal_id }
        : { kind: "Turn", sessionId: row.origin_session_id, turnId: row.origin_turn_id },
    tags: JSON.parse(row.tags).sort(),
    hostId: row.host_id,
    boxId: row.box_id,
    personaId: row.persona_id,
    repository: row.repository,
    origin:
      row.issue_number === null
        ? { kind: "Prompt" }
        : {
            kind: "Issue",
            issueNumber: row.issue_number,
            title: row.issue_title,
            htmlUrl: row.issue_html_url,
            branch: row.issue_branch,
          },
    harness: row.harness,
    harnessVersion: row.harness_version,
    model: row.model,
    boxRetention: row.box_retention,
    state: row.state,
    lastTurnId: row.last_turn_id,
    lastTurnState: row.last_turn_state,
    lastTurnAt: new Date(row.last_turn_at).toISOString(),
    lastTurn: toTurn(
      tenantId,
      {
        turn_id: row.last_turn_id,
        session_id: row.session_id,
        host_id: row.last_turn_host_id,
        box_id: row.last_turn_box_id,
        prompt: row.last_turn_prompt,
        goal: row.last_turn_goal,
        warning: row.last_turn_warning,
        state: row.last_turn_state,
        line_count: row.last_turn_line_count,
        created_at: row.last_turn_created_at,
        updated_at: row.last_turn_at,
        reason: row.last_turn_reason,
        detail: row.last_turn_detail,
        failed_at: row.last_turn_failed_at,
      },
      lastTurnImage,
    ),
    lastTurnImage: lastTurnImage ?? undefined,
    prebuildLayer: prebuildLayer ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const toTurn = (tenantId: string, row: TurnRow, image: TurnImage | null = null): Turn =>
  TurnSchema.parse({
    turnId: row.turn_id,
    tenantId,
    sessionId: row.session_id,
    boxId: row.box_id,
    prompt: row.prompt,
    ...(row.goal === null ? {} : { goal: row.goal }),
    state: row.state,
    lineCount: row.line_count,
    ...(row.state === "Failed" ? { reason: row.reason, detail: row.detail, failedAt: row.failed_at } : {}),
    ...(row.state === "Completed" && row.warning !== null ? { warning: row.warning } : {}),
    image: image ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const offerPrompt = (harness: string, turn: TurnRow): string => {
  if (turn.goal === null) return turn.prompt;
  const goalFold = GOAL_FOLDS.get(harness);
  if (goalFold === undefined) throw new Error(`turn ${turn.turn_id} carries a goal, and ${harness} takes none`);
  return goalFold.fold(turn.prompt, turn.goal, GOAL_TURN_CAP);
};

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

const boxSizeOf = (session: SessionRow): BoxSize => ({
  boxMemoryMib: session.box_memory_mib,
  boxDiskMib: session.box_disk_mib,
});

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

export const sealContext = (secretSetId: string, name: string): string => `${secretSetId}/${name}`;

export abstract class TenantSessions extends DurableObject<Env> {
  protected eventsAppended = false;
  private readonly offering = new Set<string>();

  protected abstract failPrebuild(
    tenantId: string,
    prebuildId: string,
    from: readonly string[],
    report: FailureReport,
    logUrl: string,
    now: number,
  ): Promise<boolean>;

  protected prebuildRepository(prebuildId: string): string {
    return this.ctx.storage.sql
      .exec<{ repository: string }>("SELECT repository FROM prebuilds WHERE prebuild_id = ?", prebuildId)
      .one().repository;
  }

  private hostPrebuild(sessionId: string): HostPrebuildRow | null {
    const [row] = this.ctx.storage.sql
      .exec<HostPrebuildRow>(
        "SELECT prebuild_id, head_sha, log_url FROM prebuild_sessions JOIN prebuilds USING (prebuild_id) WHERE session_id = ?",
        sessionId,
      )
      .toArray();
    return row ?? null;
  }

  private async prebuildUnstored(tenantId: string, session: SessionRow, detail: string): Promise<void> {
    const prebuild = this.hostPrebuild(session.session_id);
    if (prebuild === null) return;
    const report = { phase: "Upload" as const, detail, fix: PREBUILD_FIX };
    if (!(await this.failPrebuild(tenantId, prebuild.prebuild_id, ["Building"], report, prebuild.log_url, Date.now())))
      return;
    await this.host(session.host_id).send({ type: "BoxDiscard", sessionId: session.session_id, boxId: session.box_id });
  }

  private async prebuildStored(
    tenantId: string,
    request: SnapshotRequestRow,
    sizeBytes: number,
    now: number,
  ): Promise<void> {
    const prebuild = this.hostPrebuild(request.session_id);
    if (prebuild === null) return;
    const root = await this.env.STORE.get(request.storage_key);
    if (root === null) throw new Error(`snapshot root ${request.storage_key} was stored a moment ago and is gone`);
    const digest = await sha256Hex(new Uint8Array(await root.arrayBuffer()));
    const sql = this.ctx.storage.sql;
    const done = this.ctx.storage.transactionSync(() => {
      const moved = sql.exec(
        "UPDATE prebuilds SET state = 'Done', updated_at = ? WHERE prebuild_id = ? AND state = 'Building'",
        now,
        prebuild.prebuild_id,
      ).rowsWritten;
      if (moved === 0) return false;
      this.appendEvent(
        {
          event: "PrebuildDone",
          prebuildId: prebuild.prebuild_id,
          repository: this.prebuildRepository(prebuild.prebuild_id),
        },
        now,
      );
      sql.exec(
        "INSERT INTO prebuild_layers (prebuild_id, layer_digest, layer_size_bytes, finished_at, created_at) VALUES (?, ?, ?, ?, ?)",
        prebuild.prebuild_id,
        digest,
        sizeBytes,
        iso(now),
        now,
      );
      return true;
    });
    if (done) await this.archiveSupersededPrebuilds(tenantId, now);
  }

  private async archiveSupersededPrebuilds(tenantId: string, now: number): Promise<void> {
    const superseded = this.ctx.storage.sql
      .exec<{ session_id: string }>(
        `SELECT prebuild_sessions.session_id FROM prebuilds AS older
        JOIN prebuild_sessions ON prebuild_sessions.prebuild_id = older.prebuild_id
        JOIN sessions ON sessions.session_id = prebuild_sessions.session_id
        WHERE older.state = 'Done' AND (sessions.state = 'Archived'
          AND EXISTS (SELECT 1 FROM snapshots WHERE snapshots.session_id = sessions.session_id)
          OR sessions.state != 'Archived' AND EXISTS (SELECT 1 FROM prebuilds AS newer WHERE newer.repository = older.repository
            AND newer.guest_image_digest = older.guest_image_digest AND newer.state = 'Done' AND newer.created_at > older.created_at))`,
      )
      .toArray();
    for (const { session_id } of superseded) await this.archiveSession(tenantId, session_id, now);
  }

  private prebuildLayer(session: SessionRow, host: HostRecord, release: ReleaseRead): PrebuildLayer {
    const none = (reason: LayerAbsence["reason"], detail: string): PrebuildLayer => ({
      record: { layer: "None", reason, detail },
      restored: [],
    });
    if (host.architecture !== PREBUILD_ARCHITECTURE) {
      return none(
        "HostNotAmd64",
        `host ${host.name} is ${host.architecture}, and prebuilds build on ${PREBUILD_ARCHITECTURE} alone; run the session on an ${PREBUILD_ARCHITECTURE} host to start from a prebuild`,
      );
    }
    const base =
      release.kind === "Published"
        ? release.manifest.bases.find((each) => each.architecture === PREBUILD_ARCHITECTURE)
        : undefined;
    if (base === undefined) {
      return none(
        "NoAmd64Image",
        `the current release carries no base image for ${PREBUILD_ARCHITECTURE}, the image prebuilds build on; ask the operator to publish a release with one to start from a prebuild`,
      );
    }
    const sql = this.ctx.storage.sql;
    const [layer] = sql
      .exec<StoredSnapshotRow & { session_id: string; prebuild_id: string }>(
        `SELECT snapshots.snapshot_id, snapshots.snapshot_seq, snapshots.storage_key, snapshots.session_id, prebuilds.prebuild_id FROM prebuilds
        JOIN prebuild_sessions USING (prebuild_id) JOIN snapshots ON snapshots.session_id = prebuild_sessions.session_id
        JOIN sessions ON sessions.session_id = prebuild_sessions.session_id
        WHERE sessions.state != 'Archived' AND prebuilds.repository = ? AND prebuilds.guest_image_digest = ? AND prebuilds.state = 'Done'
        ORDER BY prebuilds.created_at DESC, snapshots.snapshot_seq DESC LIMIT 1`,
        session.repository,
        base.imageDigest,
      )
      .toArray();
    if (layer === undefined) {
      const [other] = sql
        .exec("SELECT 1 FROM prebuilds WHERE repository = ? AND state = 'Done' LIMIT 1", session.repository)
        .toArray();
      if (other === undefined) {
        return none(
          "NoPrebuild",
          `${session.repository} has no stored prebuild; start a prebuild of it so later sessions start from its layer`,
        );
      }
      return none(
        "OtherGuestImage",
        `every stored prebuild of ${session.repository} is built on another base image than ${base.imageDigest}, the base of the current release; start a prebuild of it again so later sessions start from its layer`,
      );
    }
    sql.exec(
      "INSERT OR IGNORE INTO session_chunks (session_id, digest) SELECT ?, digest FROM session_chunks WHERE session_id = ?",
      session.session_id,
      layer.session_id,
    );
    return { record: { layer: "Prebuild", prebuildId: layer.prebuild_id }, restored: [layer] };
  }

  private readonly chunks = new ChunkWriter(
    {
      pending: (tenantId, sessionId, turnId) =>
        this.ctx.storage.sql
          .exec<PendingRow>(
            "SELECT session_id, line_seq, turn_id, text, created_at FROM transcript_pending WHERE session_id = ? AND turn_id = ? ORDER BY line_seq",
            sessionId,
            turnId,
          )
          .toArray()
          .map((row) => toLine(tenantId, row)),
      record: (sessionId, turnId, storageKey, chunk) => {
        const first = chunk.lineSeqs[0];
        const last = chunk.lineSeqs.at(-1);
        if (first === undefined || last === undefined) throw new Error(`transcript chunk ${storageKey} holds no lines`);
        const sql = this.ctx.storage.sql;
        this.ctx.storage.transactionSync(() => {
          sql.exec(
            "INSERT INTO transcript_chunks (session_id, first_line_seq, last_line_seq, turn_id, storage_key, line_seqs, offsets) VALUES (?, ?, ?, ?, ?, ?, ?)",
            sessionId,
            first,
            last,
            turnId,
            storageKey,
            JSON.stringify(chunk.lineSeqs),
            JSON.stringify(chunk.offsets),
          );
          sql.exec(
            "DELETE FROM transcript_pending WHERE session_id = ? AND turn_id = ? AND line_seq <= ?",
            sessionId,
            turnId,
            last,
          );
        });
      },
    },
    this.env.STORE,
  );

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
        `SELECT turn_id FROM turns WHERE session_id = ?1 AND state IN (${IN_FLIGHT.map((_, index) => `?${index + 2}`).join(", ")})
        AND turn_id NOT IN (SELECT turn_id FROM turn_session_waits WHERE session_id = ?1)`,
        sessionId,
        ...IN_FLIGHT,
      )
      .toArray();
    return running?.turn_id ?? null;
  }

  private latestTurn(sessionId: string, state: string | null): TurnRow | null {
    const [row] = this.ctx.storage.sql
      .exec<TurnRow>(
        `${TURN_SELECT} WHERE session_id = ?1 AND (?2 IS NULL OR state = ?2)
        AND turn_id NOT IN (SELECT turn_id FROM turn_release_waits WHERE session_id = ?1)
        AND turn_id NOT IN (SELECT turn_id FROM turn_session_waits WHERE session_id = ?1)
        ORDER BY created_at DESC, turn_id DESC LIMIT 1`,
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
    this.sessionEntered(sessionId, state, now);
  }

  protected appendEvent(event: NewTenantEvent, now: number): number {
    this.eventsAppended = true;
    return appendEvent(this.ctx.storage.sql, event, now);
  }

  protected offeredPrompt(harness: string, turn: TurnRow): string {
    return offerPrompt(harness, turn);
  }

  private sessionEntered(sessionId: string, state: SessionState, now: number): void {
    if (state === "Idle") {
      const latest = this.latestTurn(sessionId, null);
      if (latest === null)
        throw new Error(`session ${sessionId} went Idle with no turn, though a start always offers one`);
      this.appendEvent({ event: "SessionIdle", sessionId, turnId: latest.turn_id }, now);
    }
    if (state === "Stopped") this.appendEvent({ event: "SessionStopped", sessionId }, now);
    if (state === "Failed") this.appendEvent({ event: "SessionFailed", sessionId }, now);
    if (state === "Archived") this.appendEvent({ event: "SessionArchived", sessionId }, now);
  }

  protected personaRow(personaId: string): PersonaRow | null {
    const [row] = this.ctx.storage.sql
      .exec<{
        secret_set_id: string;
        box_memory_mib: number;
        box_disk_mib: number;
        box_retention: BoxRetention;
        tumpel_mcp: number;
      }>(
        "SELECT secret_set_id, box_memory_mib, box_disk_mib, box_retention, tumpel_mcp FROM personas WHERE persona_id = ?",
        personaId,
      )
      .toArray();
    if (row === undefined) return null;
    return {
      secretSetId: row.secret_set_id,
      boxMemoryMib: row.box_memory_mib,
      boxDiskMib: row.box_disk_mib,
      boxRetention: row.box_retention,
      tumpelMcp: row.tumpel_mcp === 1,
    };
  }

  protected tumpelMcp(sessionId: string): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ tumpel_mcp: number }>(
        "SELECT p.tumpel_mcp FROM sessions s JOIN personas p ON p.persona_id = s.persona_id WHERE s.session_id = ?",
        sessionId,
      )
      .toArray();
    return row?.tumpel_mcp === 1;
  }

  protected async serveTurnToken(turnId: string): Promise<ConnectorTokenServed> {
    const turn = this.turnRow(turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null || !this.tumpelMcp(session.session_id)) return { kind: "Refused" };
    if (turn.state !== "Running") return { kind: "NotRunning" };
    const tenantId = this.ctx.id.name;
    if (tenantId === undefined) throw new Error(`the tenant Durable Object serving turn ${turnId} has no name`);
    const expiresAt = this.budgetStart(turn) + settingsOf(this.env).turnTotalBudgetSeconds * 1000;
    const key = await keyStoreOf(this.env).signingKey(TURN_TOKEN_SIGNING_PURPOSE);
    const accessToken = await mintTurnToken(key, {
      tenantId,
      principalId: session.principal_id,
      sessionId: session.session_id,
      turnId,
      expiresAt,
    });
    return { kind: "Served", token: { accessToken, expiresAt: iso(expiresAt) } };
  }

  private usesConnectors(sessionId: string): boolean {
    return sessionConnectorUses(this.ctx.storage.sql, sessionId).length > 0 || this.tumpelMcp(sessionId);
  }

  private boxSize(personaId: string): PersonaRow {
    const persona = this.personaRow(personaId);
    if (persona === null) throw new Error(`persona ${personaId} is gone, so its box size is unknown`);
    return persona;
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
    return `${hostDetail}. Check that ${session.repository} exists and that the GitHub App installation or the GITHUB_TOKEN of secret set ${this.secretSetName(session)} can read it, then start a new session`;
  }

  private refusedSetDetail(session: SessionRow, hostDetail: string): string {
    const name = this.secretSetName(session);
    return `${hostDetail}. The credential comes from secret set ${name}; replace its value, then send the turn again`;
  }

  private refusedCredential(session: SessionRow, now: number): CredentialRefusal | null {
    const entry = catalogEntry(session.harness, session.harness_version);
    if (entry === undefined) throw new Error(`${session.harness} ${session.harness_version} left the harness catalog`);
    const persona = this.personaRow(session.persona_id);
    if (persona === null) {
      throw new Error(`session ${session.session_id} runs on persona ${session.persona_id}, which is gone`);
    }
    const stored = storedKeys(memberRows(this.ctx.storage.sql, persona.secretSetId));
    if (stored.kind === "Unreadable") {
      throw new Error(
        `member ${stored.name} of secret set ${persona.secretSetId} no longer matches its kind (${stored.detail}); write it again, then send the turn again`,
      );
    }
    const checked = checkModelCredential(entry, stored.keys, session.model, now);
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

  protected replaceCredentialMember(
    secretSetId: string,
    member: { kind: "SubscriptionToken" | "CredentialFile"; name: string; provider: string },
    sealed: string,
    expiresAt: string,
    now: number,
  ): void {
    const sql = this.ctx.storage.sql;
    for (const table of ["secret_expiries", "secret_credentials", "secret_values"]) {
      sql.exec(`DELETE FROM ${table} WHERE secret_set_id = ? AND name = ?`, secretSetId, member.name);
    }
    sql.exec(
      "INSERT INTO secret_values (secret_set_id, name, kind, sealed, updated_at) VALUES (?, ?, ?, ?, ?)",
      secretSetId,
      member.name,
      member.kind,
      sealed,
      now,
    );
    sql.exec(
      "INSERT INTO secret_credentials (secret_set_id, name, provider) VALUES (?, ?, ?)",
      secretSetId,
      member.name,
      member.provider,
    );
    sql.exec(
      "INSERT INTO secret_expiries (secret_set_id, name, expires_at) VALUES (?, ?, ?)",
      secretSetId,
      member.name,
      expiresAt,
    );
    sql.exec("UPDATE secret_sets SET updated_at = ? WHERE secret_set_id = ?", now, secretSetId);
  }

  private async storeCredentialFile(session: SessionRow, credentialFile: string): Promise<void> {
    const persona = this.personaRow(session.persona_id);
    if (persona === null) return;
    const { secretSetId } = persona;
    const [held] = this.ctx.storage.sql
      .exec<{ name: string; provider: string; expires_at: string }>(
        `SELECT secret_values.name, secret_credentials.provider, secret_expiries.expires_at FROM secret_values
        JOIN secret_credentials USING (secret_set_id, name) JOIN secret_expiries USING (secret_set_id, name)
        WHERE secret_values.secret_set_id = ? AND secret_values.kind = 'CredentialFile'`,
        secretSetId,
      )
      .toArray();
    if (held === undefined) return;
    const now = Date.now();
    const sealed = await seal(await this.dataKey(), credentialFile, sealContext(secretSetId, held.name));
    const member = { kind: "CredentialFile" as const, name: held.name, provider: held.provider };
    const expiresAt = accessTokenExpiry(credentialFile) ?? held.expires_at;
    this.ctx.storage.transactionSync(() => this.replaceCredentialMember(secretSetId, member, sealed, expiresAt, now));
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

  protected async repositoryToken(
    tenantId: string,
    repository: GitHubRepository,
    now: number,
    scope: TokenScope,
  ): Promise<Minted> {
    const installation = await installationOn(this.env.DB, tenantId, repository.owner);
    if (installation === null) {
      const accounts = (await installationsOf(this.env.DB, tenantId)).map(({ accountLogin }) => accountLogin);
      return uncovered(accounts, repository);
    }
    const app = await appKey(this.env.DB, keyStoreOf(this.env));
    if (app === null) {
      throw new Error(
        `tenant ${tenantId} holds GitHub installation ${installation.installationId}, and the stage holds no GitHub App; create it again and connect GitHub`,
      );
    }
    return mintInstallationToken(
      (url, init) => fetch(url, init),
      this.env.GITHUB_API_ORIGIN,
      app,
      installation,
      repository,
      now,
      scope,
    );
  }

  private async ownerTokens(
    tenantId: string,
    target: GitHubRepository,
    now: number,
  ): Promise<GitHubAnswer<OwnerToken[]>> {
    const app = await appKey(this.env.DB, keyStoreOf(this.env));
    if (app === null) {
      throw new Error(
        `tenant ${tenantId} holds GitHub installations, and the stage holds no GitHub App; create it again and connect GitHub`,
      );
    }
    return mintOwnerTokens(
      (url, init) => fetch(url, init),
      this.env.GITHUB_API_ORIGIN,
      app,
      await installationsOf(this.env.DB, tenantId),
      target,
      now,
    );
  }

  private async botIdentity(token: string): Promise<IdentityAnswer> {
    const app = await storedApp(this.env.DB);
    if (app === null) {
      return {
        kind: "Refused",
        detail:
          "the stage's GitHub App was removed after it minted the repository token; create it again, connect GitHub, then send the turn again",
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
    secretSetName: string,
  ): Promise<IdentityAnswer> {
    if (minted.kind === "Minted") return this.botIdentity(minted.token);
    if (source === "None") {
      return {
        kind: "Refused",
        detail: `the turn has no GitHub credential to clone, commit and push with: no GitHub App installation of the tenant covers its repository and secret set ${secretSetName} holds no ${REPOSITORY_TOKEN}; connect GitHub, or add a Variable member ${REPOSITORY_TOKEN} to the secret set, then send the turn again`,
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
        detail: `secret set ${secretSetName} holds a ${REPOSITORY_TOKEN} written before the control plane read its GitHub user; write it again, then send the turn again`,
      };
    }
    return { kind: "Identity", identity: commitIdentity({ githubUserId: user.github_user_id, login: user.login }) };
  }

  private timers(tenantId: string, sessionId: string, changes: DeadlineChanges): Promise<void> {
    return this.env.SESSION_TIMER.getByName(sessionId).set(tenantId, changes);
  }

  protected host(hostId: string) {
    return this.env.HOST.get(this.env.HOST.idFromName(hostId));
  }

  private async offer(tenantId: string, session: SessionRow, turn: TurnRow): Promise<void> {
    this.offering.add(turn.turn_id);
    await this.armOffer(tenantId, session, turn)
      .then((offer) => this.host(session.host_id).send(offer))
      .then(() => this.offerSent(turn.turn_id))
      .catch((error: unknown) => {
        console.error(
          `OfferQueued: turn ${turn.turn_id} did not reach host ${session.host_id} and waits for its next heartbeat: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.offering.delete(turn.turn_id));
  }

  private async offerAfter(tenantId: string, session: SessionRow, turn: TurnRow, victims: HeldBox[]): Promise<void> {
    if (victims.length === 0) return this.offer(tenantId, session, turn);
    await this.armOffer(tenantId, session, turn);
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    for (const victim of victims) {
      const evicted = this.sessionRow(victim.sessionId);
      if (evicted === null) throw new Error(`session ${victim.sessionId} was picked for eviction and then not found`);
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          "INSERT INTO box_evictions (session_id, box_id, started_at) VALUES (?, ?, ?) ON CONFLICT (session_id) DO NOTHING",
          evicted.session_id,
          evicted.box_id,
          now,
        );
        sql.exec(
          "INSERT INTO turn_eviction_waits (turn_id, session_id) VALUES (?, ?)",
          turn.turn_id,
          evicted.session_id,
        );
      });
      if (evicted.state !== "Idle") continue;
      const latest = this.latestTurn(evicted.session_id, null);
      if (latest === null)
        throw new Error(`session ${evicted.session_id} has no turn, though a start always offers one`);
      this.setSessionState(evicted.session_id, "Stopping", now);
      await this.timers(tenantId, evicted.session_id, { Snapshot: null });
      await this.snapshotOrTeardown(tenantId, { ...evicted, state: "Stopping" }, latest);
    }
  }

  private releasing(sessionId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM after_turn_releases WHERE session_id = ?1 UNION ALL SELECT 1 FROM box_evictions WHERE session_id = ?1",
          sessionId,
        )
        .toArray().length > 0
    );
  }

  private async queueTurn(tenantId: string, session: SessionRow, send: TurnSend, now: number): Promise<Sent> {
    if (this.sessionRow(session.session_id)?.state !== "Stopping" || !this.releasing(session.session_id)) {
      return { kind: "Stopping" };
    }
    const turn = this.ctx.storage.transactionSync(() => {
      const queued = this.insertTurn(session.session_id, session.host_id, crypto.randomUUID(), send, now);
      this.ctx.storage.sql.exec(
        "INSERT INTO turn_release_waits (turn_id, session_id) VALUES (?, ?)",
        queued.turn_id,
        session.session_id,
      );
      return queued;
    });
    await this.timers(tenantId, session.session_id, {
      Total: { turnId: turn.turn_id, at: turn.created_at + settingsOf(this.env).turnTotalBudgetSeconds * 1000 },
    });
    return { kind: "Sent", turn: toTurn(tenantId, turn) };
  }

  private waitForSession(tenantId: string, session: SessionRow, send: TurnSend, now: number): Sent {
    const turn = this.ctx.storage.transactionSync(() => {
      const waiting = this.newTurn(session.session_id, session.host_id, session.box_id, send, now);
      this.ctx.storage.sql.exec(
        "INSERT INTO turn_session_waits (turn_id, session_id) VALUES (?, ?)",
        waiting.turn_id,
        session.session_id,
      );
      return waiting;
    });
    return { kind: "Sent", turn: toTurn(tenantId, turn) };
  }

  private waitingTurns(sessionId: string): string[] {
    return this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        "SELECT turn_id FROM turn_session_waits WHERE session_id = ? ORDER BY rowid",
        sessionId,
      )
      .toArray()
      .map((row) => row.turn_id);
  }

  protected takeNextWaiting(sessionId: string, now: number): string | null {
    if (this.inFlightTurn(sessionId) !== null) return null;
    const [next] = this.waitingTurns(sessionId);
    if (next === undefined) return null;
    const session = this.sessionRow(sessionId);
    if (session === null) throw new Error(`session ${sessionId} vanished while turn ${next} waited for it`);
    if (session.state === "Failed") {
      const detail =
        "the session could not clone its repository before the turn started, so it never ran; archive the session and start a new one on a repository that exists";
      for (const turnId of this.waitingTurns(sessionId)) {
        this.cancelWaiting(sessionId, turnId, "RepositoryCloneFailed", detail, now);
      }
      return null;
    }
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM turn_session_waits WHERE turn_id = ?", next);
    sql.exec("INSERT INTO turn_budget_starts (turn_id, started_at) VALUES (?, ?)", next, now);
    this.holdOffer(next, session.host_id, now);
    return next;
  }

  protected async startWaiting(tenantId: string, sessionId: string, turnId: string, now: number): Promise<void> {
    if (this.sessionRow(sessionId)?.state !== "Stopping") return this.runQueued(tenantId, turnId);
    this.ctx.storage.sql.exec("INSERT INTO turn_release_waits (turn_id, session_id) VALUES (?, ?)", turnId, sessionId);
    await this.timers(tenantId, sessionId, {
      Total: { turnId, at: now + settingsOf(this.env).turnTotalBudgetSeconds * 1000 },
    });
  }

  protected cancelWaiting(
    sessionId: string,
    turnId: string,
    reason: TurnFailureReason,
    detail: string,
    now: number,
  ): void {
    this.ctx.storage.sql.exec("DELETE FROM turn_session_waits WHERE turn_id = ?", turnId);
    this.recordTurnFailure(sessionId, turnId, reason, detail, iso(now), now);
  }

  private recordTurnFailure(
    sessionId: string,
    turnId: string,
    reason: TurnFailureReason,
    detail: string,
    failedAt: string,
    now: number,
  ): void {
    const sql = this.ctx.storage.sql;
    sql.exec("UPDATE turns SET state = 'Failed', updated_at = ? WHERE turn_id = ?", now, turnId);
    this.appendEvent({ event: "TurnFailed", turnId, sessionId, reason, detail }, now);
    sql.exec(
      "INSERT INTO turn_failures (turn_id, session_id, reason, detail, failed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      turnId,
      sessionId,
      reason,
      detail,
      failedAt,
      now,
    );
  }

  private budgetStart(turn: TurnRow): number {
    const [started] = this.ctx.storage.sql
      .exec<{ started_at: number }>("SELECT started_at FROM turn_budget_starts WHERE turn_id = ?", turn.turn_id)
      .toArray();
    return started?.started_at ?? turn.created_at;
  }

  private async runQueued(tenantId: string, turnId: string): Promise<void> {
    const turn = this.turnRow(turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null || turn.state !== "Offered") return;
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const move = (hostId: string, boxId: string) =>
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          "UPDATE sessions SET state = 'Running', host_id = ?, box_id = ?, updated_at = ? WHERE session_id = ?",
          hostId,
          boxId,
          now,
          session.session_id,
        );
        sql.exec(
          "UPDATE turns SET host_id = ?, box_id = ?, updated_at = ? WHERE turn_id = ?",
          hostId,
          boxId,
          now,
          turnId,
        );
        return { ...session, state: "Running", host_id: hostId, box_id: boxId };
      });
    const connectors = this.usesConnectors(session.session_id);
    if (session.state === "Idle" && (!connectors || this.channelProtocol(session.host_id) >= CONNECTORS_VERSION)) {
      return this.offer(tenantId, move(session.host_id, session.box_id), turn);
    }
    if (session.state === "Idle") {
      const handoff = await this.offerElsewhere(tenantId, move(session.host_id, session.box_id), turn);
      if (handoff === null) return;
      await this.host(handoff.hostId).send(handoff.offer);
      return this.offerSent(turnId);
    }
    if (session.state !== "Stopped") return;
    const hosts = await listHosts(this.env.DB, tenantId);
    const image = await this.imageAvailability(session.harness, session.harness_version, now);
    if (image.kind === "ReleaseUnreadable") {
      return this.failTurn(tenantId, turnId, "ImageNotReleased", image.detail, iso(now), "Stopped");
    }
    const place = (candidates: HostRecord[]) =>
      placeSession(
        candidates,
        this.listHostUsage(tenantId),
        image.image,
        boxSizeOf(session),
        connectors,
        this.heldBoxes(),
      );
    const stays = place(hosts.filter((host) => host.hostId === session.host_id && host.state === "Online"));
    const placement = stays.kind === "Placed" && stays.evict.length === 0 ? stays : place(hosts);
    if (placement.kind === "Refused") {
      const detail = `the session's box was released while the turn waited, and no host has room for a new one: ${placement.hosts.map(why).join(", ")}`;
      return this.failTurn(tenantId, turnId, "PoolExhausted", detail, iso(now), "Stopped");
    }
    await this.offerAfter(tenantId, move(placement.host.hostId, crypto.randomUUID()), turn, placement.evict);
  }

  private async evictionSettled(tenantId: string, sessionId: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (this.sessionRow(sessionId)?.state === "Stopping") return;
    const queued = this.ctx.storage.transactionSync(() => {
      const turnIds = sql
        .exec<{ turn_id: string }>("SELECT turn_id FROM turn_release_waits WHERE session_id = ?", sessionId)
        .toArray()
        .map((row) => row.turn_id);
      sql.exec("DELETE FROM turn_release_waits WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM after_turn_releases WHERE session_id = ?", sessionId);
      return turnIds;
    });
    for (const turnId of queued) await this.runQueued(tenantId, turnId);
    const waiting = this.ctx.storage.transactionSync(() => {
      const turnIds = sql
        .exec<{ turn_id: string }>("SELECT turn_id FROM turn_eviction_waits WHERE session_id = ?", sessionId)
        .toArray()
        .map((row) => row.turn_id);
      sql.exec("DELETE FROM turn_eviction_waits WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM box_evictions WHERE session_id = ?", sessionId);
      return turnIds.filter(
        (turnId) => sql.exec("SELECT 1 FROM turn_eviction_waits WHERE turn_id = ?", turnId).toArray().length === 0,
      );
    });
    for (const turnId of waiting) {
      const turn = this.turnRow(turnId);
      const session = turn === null ? null : this.sessionRow(turn.session_id);
      if (turn === null || session === null || turn.state !== "Offered") continue;
      await this.offer(tenantId, session, turn);
    }
  }

  protected offerSent(turnId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM deferred_offers WHERE turn_id = ?", turnId);
  }

  private async armOffer(tenantId: string, session: SessionRow, turn: TurnRow): Promise<StoredTurnOffer> {
    await this.timers(tenantId, session.session_id, {
      FirstLine: null,
      Total: { turnId: turn.turn_id, at: this.budgetStart(turn) + settingsOf(this.env).turnTotalBudgetSeconds * 1000 },
      Snapshot: null,
      HostOffline: null,
    });
    return this.offerMessage(session, turn);
  }

  private offerMessage(session: SessionRow, turn: TurnRow): StoredTurnOffer {
    this.ctx.storage.sql.exec(
      `INSERT INTO unreported_box_offers (box_id, host_id, box_memory_mib)
      SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM turns WHERE session_id = ?4 AND box_id = ?1 AND turn_id != ?5)
      ON CONFLICT (box_id) DO NOTHING`,
      session.box_id,
      session.host_id,
      session.box_memory_mib,
      session.session_id,
      turn.turn_id,
    );
    const prebuild = this.hostPrebuild(session.session_id);
    return {
      type: "TurnOffer",
      turnId: turn.turn_id,
      sessionId: session.session_id,
      boxId: session.box_id,
      repository: session.repository,
      harness: SessionSchema.shape.harness.parse(session.harness),
      harnessVersion: session.harness_version,
      model: session.model,
      prompt: this.offeredPrompt(session.harness, turn),
      boxMemoryMib: session.box_memory_mib,
      boxDiskMib: session.box_disk_mib,
      ...(prebuild === null ? {} : { prebuildCommitSha: prebuild.head_sha }),
    };
  }

  private insertTurn(sessionId: string, hostId: string, boxId: string, send: TurnSend, now: number): TurnRow {
    const turn = this.newTurn(sessionId, hostId, boxId, send, now);
    this.holdOffer(turn.turn_id, hostId, now);
    return turn;
  }

  private holdOffer(turnId: string, hostId: string, now: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO deferred_offers (turn_id, host_id, created_at) VALUES (?, ?, ?)",
      turnId,
      hostId,
      now,
    );
  }

  protected newTurn(sessionId: string, hostId: string, boxId: string, send: TurnSend, now: number): TurnRow {
    const turn: TurnRow = {
      turn_id: crypto.randomUUID(),
      session_id: sessionId,
      host_id: hostId,
      box_id: boxId,
      prompt: send.prompt,
      goal: send.goal ?? null,
      warning: null,
      state: "Offered",
      line_count: 0,
      created_at: now,
      updated_at: now,
      reason: null,
      detail: null,
      failed_at: null,
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
    if (turn.goal !== null) {
      this.ctx.storage.sql.exec(
        "INSERT INTO turn_goals (turn_id, goal, created_at) VALUES (?, ?, ?)",
        turn.turn_id,
        turn.goal,
        now,
      );
    }
    return turn;
  }

  protected hostHello(
    hostId: string,
    boxCapacity: number,
    usage: HostUsage,
    now: number,
    channelProtocol: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO host_usage (host_id, box_capacity, boxes_warm, load_average, memory_available_mib, created_at, updated_at, channel_protocol)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (host_id) DO UPDATE SET box_capacity = excluded.box_capacity, boxes_warm = excluded.boxes_warm,
        load_average = excluded.load_average, memory_available_mib = excluded.memory_available_mib, updated_at = excluded.updated_at,
        channel_protocol = excluded.channel_protocol`,
      hostId,
      boxCapacity,
      usage.boxesWarm,
      usage.loadAverage,
      usage.memoryAvailableMib,
      now,
      now,
      channelProtocol,
    );
    this.hostReported(hostId, usage, now);
    clearSupersededFailure(this.ctx.storage.sql, hostId);
  }

  private hostReported(hostId: string, usage: HostUsage, now: number): void {
    this.hostDiskUsage(hostId, usage, now);
    this.hostMemoryUsage(hostId, usage, now);
    this.ctx.storage.sql.exec("DELETE FROM unreported_box_offers WHERE host_id = ?", hostId);
  }

  private hostMemoryUsage(hostId: string, usage: HostUsage, now: number): void {
    const sql = this.ctx.storage.sql;
    if (usage.memoryBudgetMib === undefined || usage.memoryHeldMib === undefined) {
      sql.exec("DELETE FROM host_memory_usage WHERE host_id = ?", hostId);
      return;
    }
    sql.exec(
      `INSERT INTO host_memory_usage (host_id, memory_budget_mib, memory_held_mib, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (host_id) DO UPDATE SET memory_budget_mib = excluded.memory_budget_mib,
        memory_held_mib = excluded.memory_held_mib, updated_at = excluded.updated_at`,
      hostId,
      usage.memoryBudgetMib,
      usage.memoryHeldMib,
      now,
    );
  }

  private hostDiskUsage(hostId: string, usage: HostUsage, now: number): void {
    const sql = this.ctx.storage.sql;
    if (usage.diskBudgetMib === undefined || usage.diskHeldMib === undefined) {
      sql.exec("DELETE FROM host_disk_usage WHERE host_id = ?", hostId);
      return;
    }
    sql.exec(
      `INSERT INTO host_disk_usage (host_id, disk_budget_mib, disk_held_mib, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (host_id) DO UPDATE SET disk_budget_mib = excluded.disk_budget_mib, disk_held_mib = excluded.disk_held_mib,
        updated_at = excluded.updated_at`,
      hostId,
      usage.diskBudgetMib,
      usage.diskHeldMib,
      now,
    );
  }

  protected hostUsage(hostId: string, usage: HostUsage, now: number): void {
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
    this.hostReported(hostId, usage, now);
  }

  protected async reconcileHeldBoxes(
    tenantId: string,
    hostId: string,
    heldSessionIds: string[],
    now: number,
  ): Promise<void> {
    await this.releaseUnneededBoxes(tenantId, hostId, heldSessionIds, now);
    const gone = this.ctx.storage.sql
      .exec<{ session_id: string }>(
        "UPDATE sessions SET state = 'Stopped', updated_at = ? WHERE host_id = ? AND state = 'Idle' AND session_id NOT IN (SELECT value FROM json_each(?)) RETURNING session_id",
        now,
        hostId,
        JSON.stringify(heldSessionIds),
      )
      .toArray();
    for (const { session_id } of gone) this.sessionEntered(session_id, "Stopped", now);
    for (const { session_id } of gone) {
      await this.timers(tenantId, session_id, { Snapshot: null });
      await this.evictionSettled(tenantId, session_id);
    }
    const lost = this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        "SELECT turn_id FROM turns WHERE host_id = ? AND state = 'Running' AND session_id NOT IN (SELECT value FROM json_each(?))",
        hostId,
        JSON.stringify(heldSessionIds),
      )
      .toArray();
    if (lost.length === 0) return;
    const host = await this.hostName(tenantId, hostId);
    for (const { turn_id } of lost) {
      await this.failTurn(
        tenantId,
        turn_id,
        "BoxLost",
        `host ${host} reconnected without the box that ran the turn, so the turn's work since the last snapshot is gone; send the turn again`,
        iso(now),
      );
    }
  }

  private async releaseUnneededBoxes(
    tenantId: string,
    hostId: string,
    heldSessionIds: string[],
    now: number,
  ): Promise<void> {
    const unneeded = this.ctx.storage.sql
      .exec<SessionRow>(
        `${SESSION_SELECT} WHERE host_id = ? AND session_id IN (SELECT value FROM json_each(?))
          AND (state IN ('Stopped', 'Archived') OR (state = 'Idle' AND box_retention = 'Off'))`,
        hostId,
        JSON.stringify(heldSessionIds),
      )
      .toArray();
    for (const session of unneeded) {
      if (session.state !== "Idle") {
        await this.host(hostId).send({ type: "BoxDiscard", sessionId: session.session_id, boxId: session.box_id });
        continue;
      }
      const latest = this.latestTurn(session.session_id, null);
      if (latest === null)
        throw new Error(`session ${session.session_id} has no turn, though a start always offers one`);
      this.startAfterTurnRelease(session, now);
      await this.timers(tenantId, session.session_id, { Snapshot: null });
      await this.snapshotOrTeardown(tenantId, { ...session, state: "Stopping" }, latest);
    }
  }

  private startAfterTurnRelease(session: SessionRow, now: number): void {
    this.ctx.storage.transactionSync(() => {
      this.setSessionState(session.session_id, "Stopping", now);
      this.ctx.storage.sql.exec(
        "INSERT INTO after_turn_releases (session_id, box_id, started_at) VALUES (?, ?, ?) ON CONFLICT (session_id) DO NOTHING",
        session.session_id,
        session.box_id,
        now,
      );
    });
  }

  protected forgetHostUsage(hostId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM host_usage WHERE host_id = ?", hostId);
    this.ctx.storage.sql.exec("DELETE FROM deferred_offers WHERE host_id = ?", hostId);
    this.ctx.storage.sql.exec("DELETE FROM unreported_box_offers WHERE host_id = ?", hostId);
    forgetSupervisorUpdates(this.ctx.storage.sql, hostId);
  }

  protected runningTurnsByHost(): RunningTurns[] {
    return this.ctx.storage.sql
      .exec<{ host_id: string; running: number }>(
        `SELECT host_id, COUNT(DISTINCT session_id) AS running FROM turns WHERE state IN (${IN_FLIGHT.map(() => "?").join(", ")}) GROUP BY host_id`,
        ...IN_FLIGHT,
      )
      .toArray()
      .map((row) => ({ hostId: row.host_id, runningTurns: row.running }));
  }

  protected heldBoxes(): HeldBox[] {
    return this.ctx.storage.sql
      .exec<{
        session_id: string;
        host_id: string;
        box_memory_mib: number;
        box_disk_mib: number;
        evictable: number;
        last_turn_ended_at: number;
      }>(
        `SELECT s.session_id, s.host_id, COALESCE(m.box_memory_mib, s.box_memory_mib) AS box_memory_mib, s.box_disk_mib,
          (COALESCE(r.box_retention, 'Auto') = 'Auto' AND s.state = 'Idle'
            AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.session_id AND t.state IN ('Offered', 'Running'))
            AND NOT EXISTS (SELECT 1 FROM after_turn_releases a WHERE a.session_id = s.session_id)
            AND NOT EXISTS (SELECT 1 FROM box_evictions e WHERE e.session_id = s.session_id)
            AND NOT EXISTS (
              SELECT 1 FROM stop_failures x WHERE x.session_id = s.session_id
              AND x.created_at >= COALESCE((SELECT MAX(t.updated_at) FROM turns t WHERE t.session_id = s.session_id), 0)
            )
            AND NOT EXISTS (
              SELECT 1 FROM snapshot_failures f WHERE f.session_id = s.session_id AND f.snapshot_seq > COALESCE((
                SELECT MAX(seq) FROM (
                  SELECT snapshot_seq AS seq FROM snapshots WHERE session_id = s.session_id
                  UNION ALL SELECT snapshot_seq FROM snapshot_requests WHERE session_id = s.session_id
                )
              ), -1)
            )) AS evictable,
          COALESCE((SELECT MAX(t.updated_at) FROM turns t WHERE t.session_id = s.session_id), s.updated_at) AS last_turn_ended_at
        FROM sessions s LEFT JOIN session_box_memory m ON m.session_id = s.session_id
          LEFT JOIN session_box_retention r ON r.session_id = s.session_id
        WHERE s.state IN ('Idle', 'Stopping')`,
      )
      .toArray()
      .map((row) => ({
        sessionId: row.session_id,
        hostId: row.host_id,
        boxMemoryMib: row.box_memory_mib,
        boxDiskMib: row.box_disk_mib,
        evictable: row.evictable === 1,
        lastTurnEndedAt: row.last_turn_ended_at,
      }));
  }

  protected listHostUsage(tenantId: string): ReportedHostUsage[] {
    const sql = this.ctx.storage.sql;
    const running = new Map(this.runningTurnsByHost().map((each) => [each.hostId, each.runningTurns]));
    return sql
      .exec<HostUsageRow>(
        `SELECT u.host_id, u.box_capacity, u.boxes_warm, u.load_average, u.memory_available_mib, u.channel_protocol,
          d.disk_budget_mib, d.disk_held_mib, m.memory_budget_mib, m.memory_held_mib,
          (SELECT COALESCE(SUM(o.box_memory_mib), 0) FROM unreported_box_offers o WHERE o.host_id = u.host_id) AS unreported_mib,
          u.created_at, u.updated_at
        FROM host_usage u LEFT JOIN host_disk_usage d ON d.host_id = u.host_id
          LEFT JOIN host_memory_usage m ON m.host_id = u.host_id
        ORDER BY u.created_at, u.host_id`,
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
        ...(row.disk_budget_mib === null || row.disk_held_mib === null
          ? {}
          : { diskBudgetMib: row.disk_budget_mib, diskHeldMib: row.disk_held_mib }),
        ...(row.memory_budget_mib === null || row.memory_held_mib === null
          ? {}
          : { memoryBudgetMib: row.memory_budget_mib, memoryHeldMib: row.memory_held_mib + row.unreported_mib }),
        channelProtocol: row.channel_protocol,
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

  private settleSnapshotRequests(session: SessionRow, from: string, to: string, failedAt: string): void {
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
        `host ${from} went offline before it answered a snapshot, and the session moved to host ${to}`,
        failedAt,
      );
      this.dropPlacements(request.snapshot_id);
    }
  }

  private async imageAvailability(harness: string, harnessVersion: string, now: number): Promise<ImageLookup> {
    const release = await readRelease(this.env.RELEASES, now);
    if (release.kind === "Unreadable") return { kind: "ReleaseUnreadable", detail: release.detail };
    return {
      kind: "Read",
      image: { harness, harnessVersion, architectures: bootArchitectures(release, harness, harnessVersion) },
    };
  }

  private async guestImage(
    tenantId: string,
    session: SessionRow,
    hostId: string,
    offerSeconds: number,
    fetchSeconds: number,
    now: number,
  ): Promise<
    | { kind: "Released"; image: BootImage; host: HostRecord; release: ReleaseRead }
    | { kind: "NotReleased"; detail: string }
  > {
    const host = await hostOf(this.env.DB, tenantId, hostId);
    if (host === null)
      throw new Error(
        `turn of session ${session.session_id} is offered to host ${hostId}, which tenant ${tenantId} does not list`,
      );
    const release = await readRelease(this.env.RELEASES, now);
    if (release.kind === "Unreadable") {
      return {
        kind: "NotReleased",
        detail: `the published release is unreadable: ${release.detail}; ask the operator to publish a release with the release workflow, then send the turn again`,
      };
    }
    const boot = bootFor(release, session.harness, session.harness_version, host.architecture);
    if (boot === undefined) {
      return {
        kind: "NotReleased",
        detail: `the current release carries no ${session.harness} ${session.harness_version} guest image for ${host.architecture}, the architecture of host ${host.name}; pin a harness version the current release carries for ${host.architecture}, then send the turn again`,
      };
    }
    const signer = signerOf(
      this.env,
      this.env.RELEASES_BUCKET_NAME,
      this.env.RELEASES_ACCESS_KEY_ID,
      this.env.RELEASES_SECRET_ACCESS_KEY,
    );
    return {
      kind: "Released",
      image: await bootImage(signer, boot, offerSeconds + fetchSeconds, fetchSeconds, now),
      host,
      release,
    };
  }

  protected startSession(tenantId: string, input: NewSession, now: number): Promise<SessionStarted<StartedSession>> {
    return this.begin(tenantId, input, now, () => undefined);
  }

  protected async startSessionFromIssue(
    tenantId: string,
    input: NewSession,
    issue: IssueOfSession,
    now: number,
  ): Promise<SessionStarted<StartedSessionFromIssue>> {
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
    if (begun.kind !== "Started") return begun;
    return {
      kind: "Started",
      started: { ...begun.started, issue: { sessionId: begun.started.session.sessionId, ...issue } },
    };
  }

  protected async begin(
    tenantId: string,
    input: NewSession,
    now: number,
    record: (sessionId: string) => void,
  ): Promise<SessionStarted<StartedSession>> {
    const { start } = input;
    const image = await this.imageAvailability(input.harness, input.harnessVersion, now);
    if (image.kind === "ReleaseUnreadable") return image;
    if (await deployDraining(this.env.RELEASES)) return { kind: "Draining" };
    const uses = personaConnectorUses(this.ctx.storage.sql, start.personaId);
    const unusable = uses.filter((use) => !use.usable).map((use) => use.name);
    if (unusable.length > 0) return { kind: "ConnectorDisconnected", names: unusable };
    const persona = this.boxSize(start.personaId);
    const { boxMemoryMib, boxDiskMib } = persona;
    const placement = placeSession(
      input.hosts,
      this.listHostUsage(tenantId),
      image.image,
      { boxMemoryMib, boxDiskMib },
      uses.length > 0 || persona.tumpelMcp,
      this.heldBoxes(),
    );
    if (placement.kind === "Refused") return { kind: "Unplaced", hosts: placement.hosts };
    const tags = this.startTags(input.startedBy, start.tags ?? []);
    if (tags.length > SESSION_TAG_LIMIT) return { kind: "TagsOverLimit", tags };
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
      box_memory_mib: boxMemoryMib,
      box_disk_mib: boxDiskMib,
      box_retention: start.boxRetention ?? persona.boxRetention,
      created_at: now,
      updated_at: now,
    };
    const turn = this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO sessions (session_id, principal_id, host_id, box_id, persona_id, repository, harness, harness_version, model, state, last_line_seq, endpoint, box_disk_mib, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        session.box_disk_mib,
        session.created_at,
        session.updated_at,
      );
      copyPersonaConnectors(this.ctx.storage.sql, session.session_id, session.persona_id);
      this.ctx.storage.sql.exec(
        "INSERT INTO session_box_memory (session_id, box_memory_mib) VALUES (?, ?)",
        session.session_id,
        session.box_memory_mib,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO session_box_retention (session_id, box_retention) VALUES (?, ?)",
        session.session_id,
        session.box_retention,
      );
      this.writeTags(session.session_id, tags);
      if (input.startedBy.kind === "Turn") {
        this.ctx.storage.sql.exec(
          "INSERT INTO session_origins (session_id, origin_session_id, origin_turn_id) VALUES (?, ?, ?)",
          session.session_id,
          input.startedBy.sessionId,
          input.startedBy.turnId,
        );
      }
      record(session.session_id);
      return this.insertTurn(session.session_id, session.host_id, session.box_id, { prompt: start.prompt }, now);
    });
    await this.offerAfter(tenantId, session, turn, placement.evict);
    return {
      kind: "Started",
      started: { session: this.presentSession(tenantId, session.session_id), turn: toTurn(tenantId, turn) },
    };
  }

  protected async sendTurn(
    tenantId: string,
    sessionId: string,
    send: TurnSend,
    hosts: HostRecord[],
    now: number,
  ): Promise<Sent> {
    const session = this.sessionRow(sessionId);
    if (session === null) return { kind: "NotFound" };
    if (session.state === "Archived") return { kind: "Archived" };
    if (session.state === "Stopping" && !this.releasing(sessionId)) return { kind: "Stopping" };
    if (session.state === "Failed") return { kind: "Failed" };
    const refusal = this.refusedCredential(session, now);
    if (refusal !== null) return { kind: "CredentialRefused", personaId: session.persona_id, refusal };
    const uses = sessionConnectorUses(this.ctx.storage.sql, sessionId);
    const unusable = uses.filter((use) => !use.usable).map((use) => use.name);
    if (unusable.length > 0) return { kind: "ConnectorDisconnected", names: unusable };
    if (await deployDraining(this.env.RELEASES)) return { kind: "Draining" };
    if (this.inFlightTurn(sessionId) !== null) return this.waitForSession(tenantId, session, send, now);
    if (session.state === "Stopping") return this.queueTurn(tenantId, session, send, now);
    const connectors = uses.length > 0 || this.tumpelMcp(sessionId);
    const speaks = !connectors || this.channelProtocol(session.host_id) >= CONNECTORS_VERSION;
    const online = speaks && hosts.some((host) => host.hostId === session.host_id && host.state === "Online");
    const backBy = hosts.some((host) => host.hostId === session.host_id && host.state === "Offline")
      ? restartDeadline(this.ctx.storage.sql, session.host_id, settingsOf(this.env).heartbeatDeadlineSeconds * 1000)
      : null;
    if ((online && session.state !== "Stopped") || (!online && backBy !== null && backBy > now)) {
      const boxId = session.state === "Stopped" ? crypto.randomUUID() : session.box_id;
      const turn = this.runTurn(session, session.host_id, boxId, send, now);
      await this.offer(tenantId, { ...session, box_id: boxId }, turn);
      return { kind: "Sent", turn: toTurn(tenantId, turn) };
    }
    const missingTurnIds = session.state === "Stopped" ? [] : this.unsnapshottedTurns(sessionId);
    if (missingTurnIds.length > 0) return { kind: "Stranded", missingTurnIds };
    const image = await this.imageAvailability(session.harness, session.harness_version, now);
    if (image.kind === "ReleaseUnreadable") return image;
    const from = await this.hostName(tenantId, session.host_id);
    const place = (candidates: HostRecord[]) =>
      placeSession(
        candidates,
        this.listHostUsage(tenantId),
        image.image,
        boxSizeOf(session),
        connectors,
        this.heldBoxes(),
      );
    const stays = online ? place(hosts.filter((host) => host.hostId === session.host_id)) : null;
    const placement = stays?.kind === "Placed" && stays.evict.length === 0 ? stays : place(hosts);
    if (placement.kind === "Refused") return { kind: "Unplaced", hosts: placement.hosts };
    if (this.inFlightTurn(sessionId) !== null) return this.waitForSession(tenantId, session, send, now);
    const hostId = placement.host.hostId;
    const boxId = crypto.randomUUID();
    this.settleSnapshotRequests(session, from, placement.host.name, iso(now));
    const turn = this.runTurn(session, hostId, boxId, send, now);
    await this.offerAfter(tenantId, { ...session, host_id: hostId, box_id: boxId }, turn, placement.evict);
    await this.timers(tenantId, sessionId, { SnapshotAnswer: null });
    if (session.state !== "Stopped") {
      await this.host(session.host_id).send({ type: "BoxDiscard", sessionId, boxId: session.box_id });
    }
    return { kind: "Sent", turn: toTurn(tenantId, turn) };
  }

  private offerElsewhere(tenantId: string, session: SessionRow, turn: TurnRow): Promise<TurnHandoff | null> {
    return this.placeOffered(tenantId, session, turn, false);
  }

  private async placeOffered(
    tenantId: string,
    session: SessionRow,
    turn: TurnRow,
    staying: boolean,
  ): Promise<TurnHandoff | null> {
    const now = Date.now();
    const stay = (): null => this.deferOffer(session, turn, now);
    const movable = this.unsnapshottedTurns(session.session_id).length === 0;
    const prebuild = this.hostPrebuild(session.session_id) !== null;
    const hosts = (await listHosts(this.env.DB, tenantId)).filter(
      (host) =>
        (host.hostId === session.host_id ? staying : movable) &&
        (!prebuild || host.architecture === PREBUILD_ARCHITECTURE),
    );
    const image = await this.imageAvailability(session.harness, session.harness_version, now);
    if (image.kind === "ReleaseUnreadable") return stay();
    const usages = this.listHostUsage(tenantId).map((usage) =>
      usage.hostId === session.host_id ? { ...usage, boxesRunning: usage.boxesRunning - 1 } : usage,
    );
    const placement = placeSession(
      hosts,
      usages,
      image.image,
      boxSizeOf(session),
      this.usesConnectors(session.session_id),
      this.heldBoxes().filter((each) => each.sessionId !== session.session_id),
    );
    if (placement.kind === "Refused") return stay();
    if (placement.host.hostId === session.host_id) {
      if (placement.evict.length > 0) return this.evictFirst(tenantId, session, turn, placement.evict);
      return { type: "TurnHandoff", hostId: session.host_id, offer: await this.armOffer(tenantId, session, turn) };
    }
    const from = await this.hostName(tenantId, session.host_id);
    const hostId = placement.host.hostId;
    const boxId = crypto.randomUUID();
    this.settleSnapshotRequests(session, from, placement.host.name, iso(now));
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        "UPDATE sessions SET host_id = ?, box_id = ?, updated_at = ? WHERE session_id = ?",
        hostId,
        boxId,
        now,
        session.session_id,
      );
      sql.exec(
        "UPDATE turns SET host_id = ?, box_id = ?, updated_at = ? WHERE turn_id = ?",
        hostId,
        boxId,
        now,
        turn.turn_id,
      );
    });
    await this.timers(tenantId, session.session_id, { SnapshotAnswer: null });
    const moved = { ...session, host_id: hostId, box_id: boxId };
    if (placement.evict.length > 0) return this.evictFirst(tenantId, moved, turn, placement.evict);
    const offer = await this.armOffer(tenantId, moved, turn);
    return { type: "TurnHandoff", hostId, offer };
  }

  private async evictFirst(tenantId: string, session: SessionRow, turn: TurnRow, victims: HeldBox[]): Promise<null> {
    this.offerSent(turn.turn_id);
    await this.offerAfter(tenantId, session, turn, victims);
    return null;
  }

  private deferOffer(session: SessionRow, turn: TurnRow, now: number): null {
    this.ctx.storage.sql.exec(
      "INSERT INTO deferred_offers (turn_id, host_id, created_at) VALUES (?, ?, ?) ON CONFLICT (turn_id) DO UPDATE SET host_id = excluded.host_id",
      turn.turn_id,
      session.host_id,
      now,
    );
    return null;
  }

  protected async deferredOffers(tenantId: string, hostId: string): Promise<TurnHandoff[]> {
    const sql = this.ctx.storage.sql;
    const turnIds = sql
      .exec<{ turn_id: string }>("SELECT turn_id FROM deferred_offers WHERE host_id = ? ORDER BY created_at", hostId)
      .toArray()
      .map((row) => row.turn_id)
      .filter((turnId) => !this.offering.has(turnId));
    const handoffs: TurnHandoff[] = [];
    for (const turnId of turnIds) {
      const turn = this.turnRow(turnId);
      const session = turn === null ? null : this.sessionRow(turn.session_id);
      if (turn === null || session === null || turn.state !== "Offered") {
        this.offerSent(turnId);
        continue;
      }
      const handoff = await this.placeOffered(tenantId, session, turn, true);
      if (handoff !== null) handoffs.push(handoff);
    }
    return handoffs;
  }

  private runTurn(session: SessionRow, hostId: string, boxId: string, send: TurnSend, now: number): TurnRow {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE sessions SET state = 'Running', host_id = ?, box_id = ?, updated_at = ? WHERE session_id = ?",
        hostId,
        boxId,
        now,
        session.session_id,
      );
      return this.insertTurn(session.session_id, hostId, boxId, send, now);
    });
  }

  private steerRows(turnId: string): Steer[] {
    const turn = this.turnRow(turnId);
    const ended = turn !== null && turn.state !== "Running" && turn.state !== "Offered";
    return this.ctx.storage.sql
      .exec<{ steer_id: string; prompt: string; created_at: number; delivered: number }>(
        `SELECT s.steer_id, s.prompt, s.created_at, d.steer_id IS NOT NULL AS delivered FROM steers AS s
        LEFT JOIN steer_deliveries AS d ON d.steer_id = s.steer_id WHERE s.turn_id = ? ORDER BY s.created_at, s.steer_id`,
        turnId,
      )
      .toArray()
      .map((row) => {
        const state: SteerState = row.delivered === 1 ? "Delivered" : ended ? "TurnEnded" : "Pending";
        return { steerId: row.steer_id, turnId, prompt: row.prompt, state, createdAt: row.created_at };
      });
  }

  protected steerTurn(tenantId: string, turnId: string, prompt: string, now: number): SteerSent {
    const turn = this.getTurn(tenantId, turnId);
    if (turn === null) return { kind: "NotFound" };
    if (turn.state !== "Running") return { kind: "NotRunning", state: turn.state };
    const sql = this.ctx.storage.sql;
    const [inbox] = sql.exec("SELECT 1 FROM turn_steer_inboxes WHERE turn_id = ?", turnId).toArray();
    if (inbox === undefined) return { kind: "Unsupported" };
    const steerId = crypto.randomUUID();
    sql.exec(
      "INSERT INTO steers (steer_id, turn_id, prompt, created_at) VALUES (?, ?, ?, ?)",
      steerId,
      turnId,
      prompt,
      now,
    );
    return { kind: "Sent", steer: { steerId, turnId, prompt, state: "Pending", createdAt: now } };
  }

  protected listSteers(tenantId: string, turnId: string): Steer[] | null {
    return this.getTurn(tenantId, turnId) === null ? null : this.steerRows(turnId);
  }

  protected takeSteers(turnId: string, now: number): SteersTaken {
    return this.ctx.storage.transactionSync(() => {
      if (this.turnRow(turnId)?.state !== "Running") return { kind: "Closed" };
      const pending = this.steerRows(turnId).filter((steer) => steer.state === "Pending");
      for (const steer of pending) {
        this.ctx.storage.sql.exec(
          "INSERT INTO steer_deliveries (steer_id, delivered_at) VALUES (?, ?)",
          steer.steerId,
          now,
        );
      }
      return { kind: "Taken", prompts: pending.map((steer) => steer.prompt) };
    });
  }

  private async steerInbox(
    tenantId: string,
    session: SessionRow,
    turnId: string,
    hostId: string,
    personaFiles: PersonaFileDownload[],
    turnKey: CryptoKey,
    seconds: number,
    now: number,
  ): Promise<{ connector: DispatchConnector; personaFiles: PersonaFileDownload[] } | null> {
    if (session.harness !== "ClaudeCode" || this.channelProtocol(hostId) < CONNECTORS_VERSION) return null;
    const held = personaFiles.find((file) => file.path === STEER_SETTINGS_PATH);
    const blob = held === undefined ? null : await this.env.STORE.get(personaFileKey(tenantId, held.digest));
    if (held !== undefined && blob === null) {
      throw new Error(
        `persona file ${STEER_SETTINGS_PATH} of session ${session.session_id} is gone from object storage`,
      );
    }
    const merged = steerSettings(blob === null ? null : await blob.text());
    if (merged === null) return null;
    const bytes = new Uint8Array(new TextEncoder().encode(merged));
    const digest = await sha256Hex(bytes);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO turn_steer_inboxes (turn_id, created_at) VALUES (?, ?)",
      turnId,
      now,
    );
    await this.env.STORE.put(personaFileKey(tenantId, digest), bytes);
    const signer = signerOf(
      this.env,
      this.env.R2_BUCKET_NAME,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    );
    const settings: PersonaFileDownload = {
      path: STEER_SETTINGS_PATH,
      digest,
      sizeBytes: bytes.byteLength,
      downloadUrl: await signer.presign("GET", personaFileKey(tenantId, digest), seconds, new Date(now)),
      downloadExpiresAt: iso(now + seconds * 1000),
    };
    const turn = encodeURIComponent(turnId);
    return {
      connector: {
        connectorId: STEER_CONNECTOR_ID,
        url: `${session.endpoint}/v1/turns/${turn}/steer-inbox`,
        tokenUrl: `${session.endpoint}/v1/turns/${turn}/connectors/${STEER_CONNECTOR_ID}/token`,
        tokenCredential: await turnToken(turnKey, tenantId, turnId, STEER_CONNECTOR_ID),
      },
      personaFiles: [...personaFiles.filter((file) => file.path !== STEER_SETTINGS_PATH), settings],
    };
  }

  protected cancelTurn(tenantId: string, turnId: string, cancelledBy: string, now: number): CancelTurn {
    return this.ctx.storage.transactionSync(() => {
      const turn = this.getTurn(tenantId, turnId);
      if (turn === null) return { kind: "NotFound" };
      if (!this.waitingTurns(turn.sessionId).includes(turnId)) return { kind: "NotWaiting", state: turn.state };
      this.cancelWaiting(turn.sessionId, turnId, "Cancelled", `${cancelledBy} cancelled the turn while it waited`, now);
      const cancelled = this.getTurn(tenantId, turnId);
      if (cancelled === null) throw new Error(`turn ${turnId} vanished while it was cancelled`);
      return { kind: "Cancelled", turn: cancelled };
    });
  }

  protected async stopSession(
    tenantId: string,
    sessionId: string,
    cancelledBy: string | null,
    now: number,
  ): Promise<Stop> {
    const session = this.sessionRow(sessionId);
    if (session === null) return { kind: "NotFound" };
    if (session.state === "Archived") return { kind: "Archived" };
    if (session.state === "Stopping" || session.state === "Stopped" || session.state === "Failed") {
      return { kind: "Stopping", session: this.presentSession(tenantId, sessionId) };
    }
    const running = this.inFlightTurn(sessionId);
    if (running !== null) {
      if (cancelledBy === null) return { kind: "InFlight", turnId: running };
      const turn = this.turnRow(running);
      if (turn === null) throw new Error(`turn ${running} is in flight but has no row`);
      if (turn.state === "Running" && this.channelProtocol(session.host_id) < TURN_CANCEL_VERSION) {
        return { kind: "CancelUnspoken", turnId: running, host: await this.hostName(tenantId, session.host_id) };
      }
      const waited = `${cancelledBy} stopped the session and cancelled the turn while it waited for turn ${running}`;
      this.ctx.storage.transactionSync(() => {
        for (const turnId of this.waitingTurns(sessionId))
          this.cancelWaiting(sessionId, turnId, "Cancelled", waited, now);
      });
      const detail = `${cancelledBy} stopped the session and cancelled the turn while it was ${turn.state}`;
      await this.failTurn(tenantId, running, "Cancelled", detail, iso(now), "Stopping");
      if (turn.state === "Running") await this.host(session.host_id).send({ type: "TurnCancel", turnId: running });
    }
    const latest = this.latestTurn(sessionId, null);
    if (latest === null) throw new Error(`session ${sessionId} has no turn, though a start always offers one`);
    this.setSessionState(sessionId, "Stopping", now);
    await this.timers(tenantId, sessionId, { Snapshot: null });
    const stopping = { ...session, state: "Stopping", updated_at: now };
    await this.snapshotOrTeardown(tenantId, stopping, latest);
    return { kind: "Stopping", session: this.presentSession(tenantId, sessionId) };
  }

  private channelProtocol(hostId: string): number {
    const [row] = this.ctx.storage.sql
      .exec<{ channel_protocol: number }>("SELECT channel_protocol FROM host_usage WHERE host_id = ?", hostId)
      .toArray();
    if (row === undefined) throw new Error(`host ${hostId} runs a turn but never said hello`);
    return row.channel_protocol;
  }

  protected async archiveSession(tenantId: string, sessionId: string, now: number): Promise<Archive> {
    const session = this.sessionRow(sessionId);
    if (session === null) return { kind: "NotFound" };
    if (!["Idle", "Stopped", "Failed", "Archived"].includes(session.state)) {
      return { kind: "NotStopped", state: SessionSchema.shape.state.parse(session.state) };
    }
    const sql = this.ctx.storage.sql;
    if (session.state !== "Archived") this.setSessionState(sessionId, "Archived", now);
    await this.timers(tenantId, sessionId, {
      FirstLine: null,
      Total: null,
      Snapshot: null,
      SnapshotAnswer: null,
      Teardown: null,
      TeardownAnswer: null,
      HostOffline: null,
    });
    if (session.state === "Idle") {
      await this.host(session.host_id).send({ type: "BoxDiscard", sessionId, boxId: session.box_id });
    }
    const [restoring] = sql
      .exec(
        `SELECT 1 FROM prebuild_sessions JOIN session_prebuild_layers AS consumer USING (prebuild_id)
        JOIN turns ON turns.session_id = consumer.session_id
        WHERE prebuild_sessions.session_id = ? AND turns.state IN (SELECT value FROM json_each(?))
          AND NOT EXISTS (SELECT 1 FROM snapshots WHERE snapshots.session_id = consumer.session_id) LIMIT 1`,
        sessionId,
        JSON.stringify(IN_FLIGHT),
      )
      .toArray();
    if (restoring !== undefined) return { kind: "Archived", session: this.presentSession(tenantId, sessionId) };
    const keys = sql
      .exec<{ storage_key: string }>(
        "SELECT storage_key FROM snapshots WHERE session_id = ?1 UNION SELECT storage_key FROM snapshot_requests WHERE session_id = ?1 UNION SELECT storage_key FROM snapshot_failures WHERE session_id = ?1 AND storage_key != ''",
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
      sql.exec(
        "DELETE FROM snapshot_manifest_chunks WHERE snapshot_id IN (SELECT snapshot_id FROM snapshots WHERE session_id = ?)",
        sessionId,
      );
      sql.exec("DELETE FROM snapshots WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM snapshot_failures WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM snapshot_requests WHERE session_id = ?", sessionId);
    });
    for (let start = 0; start < keys.length; start += STORE_DELETE_BATCH) {
      await this.env.STORE.delete(keys.slice(start, start + STORE_DELETE_BATCH));
    }
    await this.releaseChunks(tenantId, sessionId);
    return { kind: "Archived", session: this.presentSession(tenantId, sessionId) };
  }

  protected async deleteSession(tenantId: string, sessionId: string, now: number): Promise<SessionDeleted> {
    const archived = await this.archiveSession(tenantId, sessionId, now);
    if (archived.kind !== "Archived") return archived;
    const sql = this.ctx.storage.sql;
    const [held] = sql.exec("SELECT 1 FROM snapshots WHERE session_id = ? LIMIT 1", sessionId).toArray();
    if (held !== undefined) return { kind: "NotStopped", state: "Archived" };
    this.ctx.storage.transactionSync(() => {
      recordObjectCleanups(
        sql,
        sql
          .exec<{ storage_key: string }>("SELECT storage_key FROM transcript_chunks WHERE session_id = ?", sessionId)
          .toArray()
          .map((row) => row.storage_key),
      );
      sql.exec("DELETE FROM sessions WHERE session_id = ?", sessionId);
    });
    return { kind: "Deleted" };
  }

  private releaseChunks(tenantId: string, sessionId: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    return this.dropChunks(tenantId, () => {
      sql.exec(`DELETE FROM chunks WHERE digest IN (${ORPHAN_CHUNKS})`, sessionId);
      sql.exec("DELETE FROM session_chunks WHERE session_id = ?", sessionId);
    });
  }

  private async manifestDigests(tenantId: string, storageKey: string): Promise<string[] | null> {
    const root = await this.env.STORE.get(storageKey);
    if (root === null) return null;
    const places = SnapshotRootSchema.parse(await root.json()).manifest;
    const parts = await Promise.all(
      places.map(async (place) => {
        const pack = await this.env.STORE.get(packKey(tenantId, place.packDigest), {
          range: { offset: place.offset, length: place.length },
        });
        if (pack === null) {
          throw new Error(
            `pack ${place.packDigest} of snapshot root ${storageKey} is gone from object storage; archive its session`,
          );
        }
        return pack.arrayBuffer();
      }),
    );
    const manifest = SnapshotManifestSchema.parse(JSON.parse(await new Blob(parts).text()));
    return [
      ...places.map((place) => place.digest),
      ...manifest.entries.flatMap((entry) => (entry.kind === "File" ? entry.chunks.map((chunk) => chunk.digest) : [])),
    ];
  }

  private async collectSnapshots(tenantId: string, stored: SnapshotRequestRow, now: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const older = sql
      .exec<{ snapshot_id: string; storage_key: string }>(
        `SELECT snapshot_id, storage_key FROM snapshots WHERE session_id = ?1 AND snapshot_seq < ?2
        UNION ALL SELECT snapshot_id, storage_key FROM snapshot_failures WHERE session_id = ?1 AND snapshot_seq < ?2 AND storage_key != ''`,
        stored.session_id,
        stored.snapshot_seq,
      )
      .toArray();
    this.ctx.storage.transactionSync(() => {
      for (const { snapshot_id } of older) {
        this.dropPlacements(snapshot_id);
        sql.exec("DELETE FROM snapshot_manifest_chunks WHERE snapshot_id = ?", snapshot_id);
        sql.exec("DELETE FROM snapshots WHERE snapshot_id = ?", snapshot_id);
      }
    });
    const keys = older.map((row) => row.storage_key);
    for (let start = 0; start < keys.length; start += STORE_DELETE_BATCH) {
      await this.env.STORE.delete(keys.slice(start, start + STORE_DELETE_BATCH));
    }
    const unread = sql
      .exec<{ snapshot_id: string; storage_key: string }>(
        "SELECT snapshot_id, storage_key FROM snapshots WHERE NOT EXISTS (SELECT 1 FROM snapshot_manifest_chunks WHERE snapshot_manifest_chunks.snapshot_id = snapshots.snapshot_id)",
      )
      .toArray();
    for (const snapshot of unread) {
      const read = await this.manifestDigests(tenantId, snapshot.storage_key);
      if (read === null) {
        console.error(
          `snapshot ${snapshot.snapshot_id} of tenant ${tenantId} has no root under ${snapshot.storage_key}, so its session_chunks keep its chunks; archive its session to free them`,
        );
        continue;
      }
      const digests = JSON.stringify(read);
      sql.exec(
        "INSERT OR IGNORE INTO snapshot_manifest_chunks (snapshot_id, digest) SELECT ?1, value FROM json_each(?2) WHERE EXISTS (SELECT 1 FROM snapshots WHERE snapshot_id = ?1)",
        snapshot.snapshot_id,
        digests,
      );
    }
    await this.archiveSupersededPrebuilds(tenantId, now);
    await this.dropChunks(tenantId, () => {
      sql.exec(
        `DELETE FROM chunk_releases WHERE digest IN (${LIVE_CHUNKS}) OR digest NOT IN (SELECT digest FROM chunks)`,
      );
      sql.exec(
        `INSERT OR IGNORE INTO chunk_releases (digest, released_at) SELECT DISTINCT digest, ?1 FROM chunks WHERE digest NOT IN (${LIVE_CHUNKS})`,
        now,
      );
      sql.exec(
        "DELETE FROM chunks WHERE digest IN (SELECT digest FROM chunk_releases WHERE released_at < ?1)",
        now - CHUNK_GRACE_MS,
      );
      sql.exec("DELETE FROM chunk_releases WHERE released_at < ?1", now - CHUNK_GRACE_MS);
    });
  }

  private dropChunks(tenantId: string, drop: () => void): Promise<void> {
    const sql = this.ctx.storage.sql;
    return this.ctx.blockConcurrencyWhile(async () => {
      const dead = this.ctx.storage.transactionSync(() => {
        drop();
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
    const [held] = this.ctx.storage.sql
      .exec<{ snapshot_id: string }>(
        "SELECT snapshot_id FROM snapshots WHERE session_id = ? AND turn_id = ? LIMIT 1",
        session.session_id,
        latest.turn_id,
      )
      .toArray();
    if (held !== undefined) {
      return this.timers(tenantId, session.session_id, { Teardown: { turnId: latest.turn_id, at: now } });
    }
    return this.timers(tenantId, session.session_id, { Snapshot: { turnId: latest.turn_id, at: now } });
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
  ): Promise<Refused | null> {
    const session = this.sessionRow(message.sessionId);
    const asked =
      session !== null &&
      (session.box_id === message.boxId ? session.host_id === hostId : this.ranBox(session, message.boxId, hostId));
    if (session === null || !asked) {
      return refused(
        `host ${hostId} answered the teardown of box ${message.boxId} of session ${message.sessionId} of tenant ${tenantId}, which it was not asked for`,
      );
    }
    if (session.box_id !== message.boxId || session.state !== "Stopping") return null;
    await this.timers(tenantId, session.session_id, { TeardownAnswer: null });
    if (message.type === "BoxGone") {
      this.setSessionState(session.session_id, "Stopped", Date.now());
      await this.evictionSettled(tenantId, session.session_id);
      return null;
    }
    this.recordStopFailure(session.session_id, message.reason, message.detail, message.failedAt);
    await this.returnToIdle(tenantId, session.session_id);
    await this.rearmSnapshot(tenantId, session.session_id);
    return null;
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

  private async returnToIdle(tenantId: string, sessionId: string): Promise<void> {
    this.setSessionState(sessionId, "Idle", Date.now());
    await this.evictionSettled(tenantId, sessionId);
  }

  private async rearmSnapshot(tenantId: string, sessionId: string): Promise<void> {
    const now = Date.now();
    const turn = this.latestTurn(sessionId, null);
    if (turn === null) throw new Error(`session ${sessionId} has no turn, though a start always offers one`);
    await this.timers(tenantId, sessionId, {
      Snapshot: { turnId: turn.turn_id, at: now + settingsOf(this.env).snapshotDelaySeconds * 1000 },
    });
  }

  protected getSession(tenantId: string, sessionId: string): Session | null {
    const [row] = this.ctx.storage.sql
      .exec<SessionViewRow>(`${SESSION_VIEW_SELECT} WHERE s.session_id = ?`, sessionId)
      .toArray();
    return row === undefined
      ? null
      : toSession(tenantId, row, this.turnImage(row.last_turn_id), this.sessionLayer(row.session_id));
  }

  protected listSessions(tenantId: string, filter: SessionFilter): Session[] {
    return this.ctx.storage.sql
      .exec<SessionViewRow>(
        `${SESSION_VIEW_SELECT} WHERE (?1 IS NULL OR s.state = ?1) AND (?2 IS NULL OR s.host_id = ?2)
        AND (?3 IS NULL OR t.updated_at <= ?3)
        AND NOT EXISTS (SELECT 1 FROM json_each(?4) AS wanted
          WHERE wanted.value NOT IN (SELECT tag FROM session_tags WHERE session_tags.session_id = s.session_id))
        AND NOT EXISTS (SELECT 1 FROM prebuild_sessions WHERE prebuild_sessions.session_id = s.session_id)
        ORDER BY s.created_at, s.session_id`,
        filter.state ?? null,
        filter.hostId ?? null,
        filter.lastTurnBefore ?? null,
        JSON.stringify(filter.tags ?? []),
      )
      .toArray()
      .map((row) => toSession(tenantId, row, this.turnImage(row.last_turn_id), this.sessionLayer(row.session_id)));
  }

  protected startTags(_startedBy: SessionStartedBy, tags: string[]): string[] {
    return tags;
  }

  private writeTags(sessionId: string, tags: string[]): void {
    this.ctx.storage.sql.exec("DELETE FROM session_tags WHERE session_id = ?", sessionId);
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO session_tags (session_id, tag) SELECT ?, value FROM json_each(?)",
      sessionId,
      JSON.stringify(tags),
    );
  }

  private tagSession(tenantId: string, sessionId: string, tags: string[], now: number): Session {
    this.ctx.storage.transactionSync(() => {
      this.writeTags(sessionId, tags);
      this.ctx.storage.sql.exec("UPDATE sessions SET updated_at = ? WHERE session_id = ?", now, sessionId);
    });
    return this.presentSession(tenantId, sessionId);
  }

  protected setSessionTags(tenantId: string, sessionId: string, tags: string[], now: number): SetTags {
    if (this.sessionRow(sessionId) === null) return { kind: "NotFound" };
    return { kind: "Tagged", session: this.tagSession(tenantId, sessionId, tags, now) };
  }

  protected patchSessionTags(tenantId: string, sessionId: string, patch: SessionTagsPatch, now: number): PatchTags {
    if (this.sessionRow(sessionId) === null) return { kind: "NotFound" };
    const removed = new Set(patch.remove ?? []);
    const kept = this.ctx.storage.sql
      .exec<{ tag: string }>("SELECT tag FROM session_tags WHERE session_id = ?", sessionId)
      .toArray()
      .map((row) => row.tag)
      .filter((tag) => !removed.has(tag));
    const tags = [...new Set([...kept, ...(patch.add ?? [])])].sort();
    if (tags.length > SESSION_TAG_LIMIT) return { kind: "TagsOverLimit", tags };
    return { kind: "Tagged", session: this.tagSession(tenantId, sessionId, tags, now) };
  }

  protected listTurns(tenantId: string, sessionId: string): Turn[] | null {
    if (this.sessionRow(sessionId) === null) return null;
    return this.ctx.storage.sql
      .exec<TurnRow>(`${TURN_SELECT} WHERE session_id = ? ORDER BY created_at, turn_id`, sessionId)
      .toArray()
      .map((row) => toTurn(tenantId, row, this.turnImage(row.turn_id)));
  }

  protected getTurn(tenantId: string, turnId: string): Turn | null {
    const row = this.turnRow(turnId);
    return row === null ? null : toTurn(tenantId, row, this.turnImage(turnId));
  }

  private turnImage(turnId: string): TurnImage | null {
    const [row] = this.ctx.storage.sql
      .exec<ImageRow>(
        `SELECT 'Full' AS kind, guest_image_digest AS digest, NULL AS harness_layer_digest FROM turn_full_images WHERE turn_id = ?1
        UNION ALL SELECT 'Layered', base_image_digest, harness_layer_digest FROM turn_layered_images WHERE turn_id = ?1`,
        turnId,
      )
      .toArray();
    if (row === undefined) return null;
    return TurnImageSchema.parse(
      row.kind === "Full"
        ? { kind: "Full", guestImageDigest: row.digest }
        : { kind: "Layered", baseImageDigest: row.digest, harnessLayerDigest: row.harness_layer_digest },
    );
  }

  private sessionLayer(sessionId: string): SessionPrebuildLayer | null {
    const [row] = this.ctx.storage.sql
      .exec<LayerRow>(
        `SELECT p.prebuild_id, l.layer_digest, NULL AS reason, NULL AS detail FROM session_prebuild_layers AS p
        JOIN prebuild_layers AS l ON l.prebuild_id = p.prebuild_id WHERE p.session_id = ?1
        UNION ALL SELECT NULL, NULL, reason, detail FROM session_layer_absences WHERE session_id = ?1`,
        sessionId,
      )
      .toArray();
    if (row === undefined) return null;
    return SessionPrebuildLayerSchema.parse(
      row.prebuild_id === null
        ? { layer: "None", reason: row.reason, detail: row.detail }
        : { layer: "Prebuild", prebuildId: row.prebuild_id, layerDigest: row.layer_digest },
    );
  }

  private recordImage(turnId: string, image: BootImage, now: number): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM turn_full_images WHERE turn_id = ?", turnId);
      sql.exec("DELETE FROM turn_layered_images WHERE turn_id = ?", turnId);
      if (image.kind === "Full") {
        sql.exec(
          "INSERT INTO turn_full_images (turn_id, guest_image_digest, created_at) VALUES (?, ?, ?)",
          turnId,
          image.imageDigest,
          now,
        );
        return;
      }
      sql.exec(
        "INSERT INTO turn_layered_images (turn_id, base_image_digest, harness_layer_digest, created_at) VALUES (?, ?, ?, ?)",
        turnId,
        image.base.imageDigest,
        image.layer.layer.layerDigest,
        now,
      );
    });
  }

  private recordLayer(sessionId: string, layer: LayerRecord, now: number): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM session_prebuild_layers WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM session_layer_absences WHERE session_id = ?", sessionId);
      if (layer.layer === "Prebuild") {
        sql.exec(
          "INSERT INTO session_prebuild_layers (session_id, prebuild_id, created_at) VALUES (?, ?, ?)",
          sessionId,
          layer.prebuildId,
          now,
        );
        return;
      }
      sql.exec(
        "INSERT INTO session_layer_absences (session_id, reason, detail, created_at) VALUES (?, ?, ?, ?)",
        sessionId,
        layer.reason,
        layer.detail,
        now,
      );
    });
  }

  protected readTurns(tenantId: string, turnIds: string[]): WaitedTurns {
    const missing = turnIds.find((turnId) => this.turnRow(turnId) === null);
    if (missing !== undefined) return { kind: "NotFound", turnId: missing };
    const turns = turnIds.map((turnId) => {
      const turn = this.getTurn(tenantId, turnId);
      if (turn === null) throw new Error(`turn ${turnId} vanished while the read collected it`);
      return turn;
    });
    return { kind: "Read", turns };
  }

  protected getTurnFailure(tenantId: string, turnId: string): TurnFailure | null {
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

  protected listStopFailures(tenantId: string, sessionId: string): StopFailure[] | null {
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

  protected listSnapshots(tenantId: string, sessionId: string): Snapshot[] | null {
    if (this.sessionRow(sessionId) === null) return null;
    return this.ctx.storage.sql
      .exec<SnapshotRow>(`${SNAPSHOT_SELECT} WHERE session_id = ? ORDER BY snapshot_seq`, sessionId)
      .toArray()
      .map((row) => toSnapshot(tenantId, row));
  }

  protected listCredentialHandovers(tenantId: string, sessionId: string): CredentialHandover[] | null {
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

  protected getSnapshot(tenantId: string, snapshotId: string): Snapshot | null {
    const [row] = this.ctx.storage.sql
      .exec<SnapshotRow>(`${SNAPSHOT_SELECT} WHERE snapshot_id = ?`, snapshotId)
      .toArray();
    return row === undefined ? null : toSnapshot(tenantId, row);
  }

  protected transcriptCursor(
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

  protected turnMetricDimensions(turnIds: readonly string[]): Record<string, Dimensions> {
    return Object.fromEntries(
      this.ctx.storage.sql
        .exec<{ turn_id: string; dimensions: string }>(
          "SELECT turn_id, dimensions FROM turn_metric_dimensions WHERE turn_id IN (SELECT value FROM json_each(?))",
          JSON.stringify(turnIds),
        )
        .toArray()
        .map((row) => [row.turn_id, DimensionsSchema.parse(JSON.parse(row.dimensions))]),
    );
  }

  protected async prepareOffer(tenantId: string, turnId: string, hostId: string, now: number): Promise<PreparedOffer> {
    const turn = this.turnRow(turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null) {
      throw new Error(`host ${hostId} has an offer for turn ${turnId}, which tenant ${tenantId} does not hold`);
    }
    if (turn.state !== "Offered") return { kind: "Withdrawn" };
    const entry = catalogEntry(session.harness, session.harness_version);
    if (entry === undefined) {
      const detail = `the session runs ${session.harness} ${session.harness_version}, which left the harness catalog, so no image runs the turn; start a new session on a listed version`;
      await this.failTurn(tenantId, turnId, "ImageNotReleased", detail, iso(now));
      return { kind: "Withdrawn" };
    }
    const persona = this.personaRow(session.persona_id);
    if (persona === null) {
      const detail = `the session runs on persona ${session.persona_id}, which is gone, so the turn has no secret set to run on; start a new session on an existing persona`;
      await this.failTurn(tenantId, turnId, "CredentialRefused", detail, iso(now));
      return { kind: "Withdrawn" };
    }
    const uses = sessionConnectorUses(this.ctx.storage.sql, session.session_id);
    const unusable = uses.filter((use) => !use.usable).map((use) => use.name);
    if (unusable.length > 0) {
      await this.failTurn(
        tenantId,
        turnId,
        "ConnectorDisconnected",
        `${disconnectedDetail(unusable)}; ${DISCONNECTED_FIX}`,
        iso(now),
      );
      return { kind: "Withdrawn" };
    }
    const turnKey = await keyStoreOf(this.env).signingKey(TURN_TOKEN_PURPOSE);
    const builtIn = this.tumpelMcp(session.session_id)
      ? [{ connector_id: TUMPEL_CONNECTOR_ID, name: TUMPEL_CONNECTOR_ID, url: `${session.endpoint}${MCP_PATH}` }]
      : [];
    const connectors: DispatchConnector[] = await Promise.all(
      [...uses, ...builtIn].map(async (use) => ({
        connectorId: use.connector_id,
        name: use.name,
        url: use.url,
        tokenUrl: `${session.endpoint}/v1/turns/${encodeURIComponent(turnId)}/connectors/${encodeURIComponent(use.connector_id)}/token`,
        tokenCredential: await turnToken(turnKey, tenantId, turnId, use.connector_id),
      })),
    );
    const { secretSetId } = persona;
    const prebuild = this.hostPrebuild(session.session_id);
    const members = prebuild === null ? await this.members(secretSetId) : [];
    const dispatch =
      prebuild === null
        ? dispatchVariables(entry, members, session.model, now)
        : { kind: "Ready" as const, variables: [], arguments: [] };
    if (dispatch.kind !== "Ready") {
      const refused = credentialProblem(
        dispatch,
        `secret set ${this.secretSetName(session)}`,
        session.harness,
        "send the turn again",
      );
      const reason = dispatch.kind === "Expired" ? "CredentialExpired" : "CredentialRefused";
      await this.failTurn(tenantId, turnId, reason, `${refused.detail}; ${refused.fix}`, iso(now));
      return { kind: "Withdrawn" };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO turn_metric_dimensions (turn_id, dimensions, created_at) VALUES (?, ?, ?)
      ON CONFLICT (turn_id) DO UPDATE SET dimensions = excluded.dimensions`,
      turnId,
      JSON.stringify(
        offeredDimensions(
          session.persona_id,
          secretSetId,
          prebuild === null ? checkModelCredential(entry, members, session.model, now) : null,
        ),
      ),
      now,
    );
    const settings = settingsOf(this.env);
    const guest = await this.guestImage(
      tenantId,
      session,
      hostId,
      settings.turnOfferTtlSeconds,
      settings.turnImageFetchBudgetSeconds,
      now,
    );
    if (guest.kind === "NotReleased") {
      await this.failTurn(tenantId, turnId, "ImageNotReleased", guest.detail, iso(now));
      return { kind: "Withdrawn" };
    }
    const target = githubRepository(session.repository);
    const minted: Minted =
      target === null
        ? { kind: "NoToken" }
        : await this.repositoryToken(tenantId, target, now, prebuild === null ? AGENT_SCOPE : CONTENTS_READ);
    if (prebuild !== null && minted.kind !== "Minted") {
      const reason = minted.kind === "NoToken" ? "no installation covers it" : minted.detail;
      await this.failTurn(
        tenantId,
        turnId,
        "RepositoryTokenRefused",
        `a prebuild clones ${session.repository} with an installation token of the stage's GitHub App that reads its contents, and none was minted: ${reason}; connect GitHub for the repository's owner, then start the prebuild again`,
        iso(now),
      );
      return { kind: "Withdrawn" };
    }
    const credential = repositoryCredential(dispatch.variables, minted);
    if (credential.kind === "Refused") {
      await this.failTurn(tenantId, turnId, "RepositoryTokenRefused", credential.detail, iso(now));
      return { kind: "Withdrawn" };
    }
    const { source } = credential;
    const owners =
      prebuild === null && target !== null && minted.kind === "Minted"
        ? await this.ownerTokens(tenantId, target, now)
        : null;
    if (owners !== null && !owners.ok) {
      await this.failTurn(
        tenantId,
        turnId,
        "RepositoryTokenRefused",
        `${owners.detail}; send the turn again once GitHub answers, and check https://www.githubstatus.com if it keeps failing`,
        iso(now),
      );
      return { kind: "Withdrawn" };
    }
    const variables =
      owners === null || target === null
        ? credential.variables
        : withOwnerTokens(credential.variables, owners.value, target);
    const identity = await this.commitIdentityOf(minted, source, secretSetId, this.secretSetName(session));
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
      .exec<StoredSnapshotRow>(
        "SELECT snapshot_id, snapshot_seq, storage_key FROM snapshots WHERE session_id = ? ORDER BY snapshot_seq DESC LIMIT 1",
        session.session_id,
      )
      .toArray();
    this.recordImage(turnId, guest.image, now);
    const restored =
      stored.length > 0 ? stored : this.firstBox(session, prebuild !== null, guest.host, guest.release, now);
    const credentialSeconds = turnCredentialSeconds(settings);
    const snapshots = await this.downloads(restored, credentialSeconds, now);
    const files =
      prebuild === null ? await this.personaFiles(tenantId, session.persona_id, credentialSeconds, now) : [];
    const inbox =
      prebuild === null
        ? await this.steerInbox(tenantId, session, turnId, hostId, files, turnKey, credentialSeconds, now)
        : null;
    const personaFiles = inbox === null ? files : inbox.personaFiles;
    if (inbox !== null) connectors.push(inbox.connector);
    return {
      kind: "Ready",
      credential: {
        credentialHandoverId: handover.credentialHandoverId,
        expiresAt: iso(now + credentialSeconds * 1000),
        variables,
        arguments: dispatch.arguments,
        connectors,
        ...(dispatch.credentialFile === undefined ? {} : { credentialFile: dispatch.credentialFile }),
      },
      lastLineSeq: session.last_line_seq,
      snapshots,
      personaFiles,
      image: guest.image,
      ...identity.identity,
    };
  }

  private firstBox(
    session: SessionRow,
    buildsPrebuild: boolean,
    host: HostRecord,
    release: ReleaseRead,
    now: number,
  ): StoredSnapshotRow[] {
    const picked: PrebuildLayer = buildsPrebuild
      ? {
          record: {
            layer: "None",
            reason: "BuildsPrebuild",
            detail: `the session builds a prebuild of ${session.repository}, so its box starts from the guest image alone`,
          },
          restored: [],
        }
      : this.prebuildLayer(session, host, release);
    this.recordLayer(session.session_id, picked.record, now);
    return picked.restored;
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

  private async downloads(stored: StoredSnapshotRow[], seconds: number, now: number): Promise<SnapshotDownload[]> {
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

  protected async hostPresence(
    tenantId: string,
    hostId: string,
    presence: "Online" | "Offline",
    now: number,
  ): Promise<void> {
    this.appendEvent({ event: presence === "Online" ? "HostOnline" : "HostOffline", hostId }, now);
    const inFlight = this.ctx.storage.sql
      .exec<{ session_id: string; turn_id: string }>(
        "SELECT session_id, turn_id FROM turns WHERE host_id = ? AND state = 'Running'",
        hostId,
      )
      .toArray();
    const heartbeatDeadlineMs = settingsOf(this.env).heartbeatDeadlineSeconds * 1000;
    for (const { session_id, turn_id } of inFlight) {
      await this.timers(tenantId, session_id, {
        HostOffline: presence === "Offline" ? { turnId: turn_id, at: now + heartbeatDeadlineMs } : null,
      });
    }
  }

  private async hostName(tenantId: string, hostId: string): Promise<string> {
    const host = await hostOf(this.env.DB, tenantId, hostId);
    if (host === null) throw new Error(`host ${hostId} runs a session of tenant ${tenantId}, which does not list it`);
    return host.name;
  }

  private async hostOffline(hostId: string): Promise<boolean> {
    const row = await this.env.DB.prepare("SELECT state FROM hosts WHERE host_id = ?")
      .bind(hostId)
      .first<{ state: string }>();
    return row?.state === "Offline";
  }

  protected async hostMessage(
    tenantId: string,
    hostId: string,
    message: SessionHostMessage,
  ): Promise<HostReply | null> {
    if (message.type === "SnapshotChunks") return this.snapshotChunks(tenantId, hostId, message);
    if (message.type === "SnapshotPacks") return this.snapshotPacks(tenantId, hostId, message);
    if (message.type === "RestoreChunks") return this.restoreChunks(tenantId, hostId, message);
    if ((message.type === "TurnComplete" || message.type === "TurnFailed") && message.credentialFile !== undefined) {
      const offered = this.offeredTurn(hostId, message);
      if (offered.type === "Refused") return offered;
      await this.storeCredentialFile(offered.session, message.credentialFile);
    }
    if (message.type === "TurnRepositoryCloneFailed") return this.cloneFailed(tenantId, hostId, message);
    if (message.type === "TurnFailed")
      return this.endingImageFetch(tenantId, hostId, message, () => this.turnFailed(tenantId, hostId, message));
    if (message.type === "TurnClaim")
      return this.endingImageFetch(tenantId, hostId, message, () => this.turnClaim(tenantId, hostId, message));
    if (message.type === "SnapshotDone" || message.type === "SnapshotFailed") {
      return this.snapshotAnswer(tenantId, hostId, message);
    }
    if (message.type === "BoxGone" || message.type === "BoxTeardownFailed") {
      return this.teardownAnswer(tenantId, hostId, message);
    }
    const offered = this.offeredTurn(hostId, message);
    if (offered.type === "Refused") return offered;
    await this.endingImageFetch(tenantId, hostId, message, () => this.turnEvent(tenantId, offered, message));
    return null;
  }

  private snapshotUploadWindow(
    tenantId: string,
    hostId: string,
    snapshotId: string,
  ): { request: SnapshotRequestRow; now: number; expiresAt: number; seconds: number } | Refused | null {
    const [request] = this.ctx.storage.sql
      .exec<SnapshotRequestRow & { created_at: number }>(
        "SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, created_at FROM snapshot_requests WHERE snapshot_id = ?",
        snapshotId,
      )
      .toArray();
    if (request === undefined) return null;
    if (this.sessionRow(request.session_id)?.host_id !== hostId) {
      return refused(
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
  ): ChunkReply | Refused | null {
    const window = this.snapshotUploadWindow(tenantId, hostId, message.snapshotId);
    if (window === null || "type" in window) return window;
    const sql = this.ctx.storage.sql;
    const digests = JSON.stringify(message.digests);
    const held = this.ctx.storage.transactionSync(() => {
      sql.exec(
        "INSERT OR IGNORE INTO session_chunks (session_id, digest) SELECT ?1, value FROM json_each(?2)",
        window.request.session_id,
        digests,
      );
      const held = sql
        .exec<{ digest: string; pack_digest: string; byte_offset: number; byte_length: number }>(
          "SELECT digest, MIN(pack_digest) AS pack_digest, byte_offset, byte_length FROM chunks WHERE digest IN (SELECT value FROM json_each(?1)) GROUP BY digest ORDER BY digest",
          digests,
        )
        .toArray();
      for (const row of held) {
        sql.exec(
          "INSERT OR IGNORE INTO snapshot_chunks (snapshot_id, digest, pack_digest, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?)",
          window.request.snapshot_id,
          row.digest,
          row.pack_digest,
          row.byte_offset,
          row.byte_length,
        );
      }
      return held;
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
  ): Promise<ChunkReply | Refused | null> {
    const window = this.snapshotUploadWindow(tenantId, hostId, message.snapshotId);
    if (window === null || "type" in window) return window;
    const listed = new Set(message.packs.map((pack) => pack.packDigest));
    const unlisted = message.chunks.find((chunk) => !listed.has(chunk.packDigest));
    if (unlisted !== undefined) {
      return refused(
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
  ): Promise<ChunkReply | Refused | null> {
    const turn = this.turnRow(message.turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null || turn.host_id !== hostId) {
      return refused(`host ${hostId} asked for the chunks of turn ${message.turnId}, which is not offered to it`);
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
      return refused(`host ${hostId} asked for the chunks of turn ${message.turnId}, which was never sent to it`);
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

  private async cloneFailed(tenantId: string, hostId: string, message: CloneFailed): Promise<HostReply | null> {
    const offered = this.offeredTurn(hostId, message);
    if (offered.type === "Refused") return offered;
    const { turn, session } = offered;
    if (!IN_FLIGHT.includes(turn.state)) return null;
    const detail = this.cloneFailureDetail(session, message.detail);
    await this.failTurn(tenantId, turn.turn_id, "RepositoryCloneFailed", detail, message.failedAt, "Failed");
    return { type: "BoxDiscard", sessionId: session.session_id, boxId: session.box_id };
  }

  private async turnFailed(tenantId: string, hostId: string, message: TurnFailed): Promise<HostReply | null> {
    const offered = this.offeredTurn(hostId, message);
    if (offered.type === "Refused") return offered;
    const { turn, session } = offered;
    const now = Date.now();
    if (message.reason === "PoolExhausted" && turn.state === "Offered") {
      this.ctx.storage.sql.exec("DELETE FROM unreported_box_offers WHERE box_id = ?", turn.box_id);
      this.ctx.storage.sql.exec(
        `INSERT INTO turn_refusals (turn_id, host_id, detail, refused_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (turn_id) DO UPDATE SET host_id = excluded.host_id, detail = excluded.detail, refused_at = excluded.refused_at`,
        turn.turn_id,
        hostId,
        message.detail,
        now,
      );
      return this.deferOffer(session, turn, now);
    }
    if (message.reason === "HostUpdating" && turn.state === "Offered")
      return this.offerElsewhere(tenantId, session, turn);
    const stopped = message.reason === "HostUpdating" && turn.state === "Running" && turn.line_count === 0;
    if (stopped || (message.reason === "NotClaimed" && IN_FLIGHT.includes(turn.state))) {
      const boxId = stopped ? crypto.randomUUID() : turn.box_id;
      const sql = this.ctx.storage.sql;
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          "UPDATE turns SET state = 'Offered', box_id = ?, updated_at = ? WHERE turn_id = ?",
          boxId,
          now,
          turn.turn_id,
        );
        if (stopped)
          sql.exec(
            "UPDATE sessions SET box_id = ?, updated_at = ? WHERE session_id = ?",
            boxId,
            now,
            session.session_id,
          );
      });
      const offeredAgain = { ...turn, state: "Offered" as const, box_id: boxId };
      if (stopped) return this.offerElsewhere(tenantId, { ...session, box_id: boxId }, offeredAgain);
      return this.offerMessage(session, offeredAgain);
    }
    const detail =
      message.reason === "CredentialRefused" ? this.refusedSetDetail(session, message.detail) : message.detail;
    await this.failTurn(tenantId, turn.turn_id, message.reason, detail, message.failedAt);
    return null;
  }

  private offeredTurn(
    hostId: string,
    message: TurnEvent | CloneFailed | TurnFailed | TurnClaim,
  ): OfferedTurn | Refused {
    const turn = this.turnRow(message.turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null || turn.host_id !== hostId) {
      return refused(`host ${hostId} sent ${message.type} for turn ${message.turnId}, which is not offered to it`);
    }
    return { type: "Offered", turn, session };
  }

  private async turnClaim(tenantId: string, hostId: string, message: TurnClaim): Promise<HostReply> {
    const offered = this.offeredTurn(hostId, message);
    if (offered.type === "Refused") return offered;
    const { turn, session } = offered;
    if (turn.state !== "Offered") return { type: "TurnWithdrawn", turnId: turn.turn_id };
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("UPDATE turns SET state = 'Running', updated_at = ? WHERE turn_id = ?", now, turn.turn_id);
      sql.exec(
        "INSERT INTO turn_claims (turn_id, claimed_at) VALUES (?, ?) ON CONFLICT (turn_id) DO UPDATE SET claimed_at = excluded.claimed_at",
        turn.turn_id,
        now,
      );
      sql.exec("UPDATE sessions SET state = 'Running', updated_at = ? WHERE session_id = ?", now, session.session_id);
      this.appendEvent({ event: "TurnStarted", turnId: turn.turn_id, sessionId: session.session_id }, now);
      sql.exec(
        `UPDATE prebuilds SET state = 'Building', updated_at = ?1 WHERE state = 'Dispatched'
        AND prebuild_id IN (SELECT prebuild_id FROM prebuild_sessions WHERE session_id = ?2)`,
        now,
        session.session_id,
      );
    });
    await this.timers(tenantId, session.session_id, {
      Total: { turnId: turn.turn_id, at: now + settingsOf(this.env).turnTotalBudgetSeconds * 1000 },
    });
    return { type: "TurnClaimed", turnId: turn.turn_id };
  }

  private async endingImageFetch<Reply>(
    tenantId: string,
    hostId: string,
    message: TurnEvent | TurnFailed | TurnClaim,
    handle: () => Promise<Reply>,
  ): Promise<Reply> {
    const now = Date.now();
    const offered = this.offeredTurn(hostId, message);
    if (offered.type === "Refused" || message.type === "TurnImageFetching") return handle();
    const [fetch] = this.ctx.storage.sql
      .exec<{ started_at: number }>(
        "DELETE FROM turn_image_fetches WHERE turn_id = ? RETURNING started_at",
        offered.turn.turn_id,
      )
      .toArray();
    const reply = await handle();
    if (fetch === undefined) return reply;
    const { turn, session } = offered;
    await this.recordTiming(tenantId, "turn.image_fetch.duration", turn, session, fetch.started_at, now);
    return reply;
  }

  private async recordTiming(
    tenantId: string,
    metric: TimingMetric,
    turn: TurnRow,
    session: SessionRow,
    startedAt: number,
    endedAt: number,
  ): Promise<void> {
    const dimensions = { hostId: turn.host_id, harness: session.harness };
    await this.env.TENANT_METRICS.getByName(tenantId)
      .record(
        timingBatch(metric, { turnId: turn.turn_id, sessionId: session.session_id, dimensions }, startedAt, endedAt),
      )
      .catch((error: unknown) => {
        console.error(
          `TurnTimingRejected: the metrics store refused ${metric} for turn ${turn.turn_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private async turnEvent(tenantId: string, { turn, session }: OfferedTurn, message: TurnEvent): Promise<void> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    if (message.type === "TurnImageFetching") {
      sql.exec(
        "INSERT INTO turn_image_fetches (turn_id, started_at) VALUES (?, ?) ON CONFLICT (turn_id) DO UPDATE SET started_at = excluded.started_at",
        turn.turn_id,
        now,
      );
      return;
    }
    if (message.type === "TurnRepositoryReady") {
      if (turn.state !== "Running" || turn.line_count > 0) return;
      const settings = settingsOf(this.env);
      return this.timers(tenantId, session.session_id, {
        FirstLine: { turnId: turn.turn_id, at: now + settings.turnFirstLineBudgetSeconds * 1000 },
      });
    }
    if (turn.state !== "Running") return;
    if (message.type === "TurnLine") {
      const [claim] =
        turn.line_count === 0
          ? sql
              .exec<{ claimed_at: number }>(
                "DELETE FROM turn_claims WHERE turn_id = ? RETURNING claimed_at",
                turn.turn_id,
              )
              .toArray()
          : [];
      await this.appendLine(tenantId, session, turn, message.lineSeq, message.text, now);
      if (claim === undefined) return;
      return this.recordTiming(tenantId, "turn.first_output.duration", turn, session, claim.claimed_at, now);
    }
    const held = this.sessionRow(session.session_id)?.last_line_seq ?? 0;
    if (message.lastLineSeq !== held) {
      return this.failTurn(
        tenantId,
        turn.turn_id,
        "TranscriptGap",
        `the turn completed at lineSeq ${message.lastLineSeq}, but the control plane holds lines up to ${held}; the lines in between were lost on the channel, so send the turn again`,
        iso(now),
      );
    }
    const prebuild = this.hostPrebuild(session.session_id) !== null;
    if (
      !prebuild &&
      successResultOf(HarnessSchema.parse(session.harness)) !== null &&
      !this.printedResult(turn.turn_id)
    ) {
      return this.failTurn(
        tenantId,
        turn.turn_id,
        "HarnessExitedWithoutResult",
        "the harness exited without printing a successful result, so the turn stopped before it finished; the session's next snapshot keeps the work done so far, so send the turn again to continue it",
        iso(now),
      );
    }
    if (this.snapshotAsked(turn.turn_id)) return;
    await this.chunks.write(tenantId, session.session_id, turn.turn_id, 1);
    if (message.warning !== undefined)
      sql.exec(
        "INSERT INTO turn_warnings (turn_id, warning, created_at) VALUES (?, ?, ?)",
        turn.turn_id,
        message.warning,
        now,
      );
    await this.requestSnapshot(tenantId, session, turn);
    await this.timers(tenantId, session.session_id, { FirstLine: null, Total: null, HostOffline: null });
  }

  private snapshotAsked(turnId: string): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ snapshot_id: string }>("SELECT snapshot_id FROM snapshot_requests WHERE turn_id = ? LIMIT 1", turnId)
      .toArray();
    return row !== undefined;
  }

  private async snapshotNotStored(tenantId: string, request: SnapshotRequestRow, detail: string): Promise<void> {
    await this.failTurn(
      tenantId,
      request.turn_id,
      "SnapshotNotStored",
      `${detail}; send the turn again`,
      iso(Date.now()),
    );
  }

  private printedResult(turnId: string): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ turn_id: string }>("SELECT turn_id FROM turn_results WHERE turn_id = ?", turnId)
      .toArray();
    return row !== undefined;
  }

  private async endTurn(tenantId: string, turn: TurnRow, now: number, record: () => void): Promise<void> {
    await this.chunks.write(tenantId, turn.session_id, turn.turn_id, 1);
    const next = this.ctx.storage.transactionSync(() => {
      record();
      this.ctx.storage.sql.exec("DELETE FROM turn_image_fetches WHERE turn_id = ?", turn.turn_id);
      this.ctx.storage.sql.exec("DELETE FROM turn_claims WHERE turn_id = ?", turn.turn_id);
      releaseConnectorCredentials(this.ctx.storage.sql);
      return this.takeNextWaiting(turn.session_id, now);
    });
    const session = this.sessionRow(turn.session_id);
    const release = session?.state === "Idle" && session.box_retention === "Off";
    if (release) this.startAfterTurnRelease(session, now);
    const delay =
      this.hostPrebuild(turn.session_id) === null && !release ? settingsOf(this.env).snapshotDelaySeconds * 1000 : 0;
    await this.timers(tenantId, turn.session_id, {
      FirstLine: null,
      Total: null,
      HostOffline: null,
      Snapshot: { turnId: turn.turn_id, at: now + delay },
    });
    if (next !== null) await this.startWaiting(tenantId, turn.session_id, next, now);
  }

  protected async deadlineReached(tenantId: string, due: SessionDueDeadline): Promise<void> {
    const { turnId } = due.deadline;
    const { name } = due;
    const turn = this.turnRow(turnId);
    if (turn === null) return;
    const sessionId = turn.session_id;
    const session = this.sessionRow(sessionId);
    if (session === null) return;
    const settings = settingsOf(this.env);
    const failedAt = iso(Date.now());
    if (name === "Snapshot") {
      if (session.state !== "Idle" && session.state !== "Stopping") return;
      return this.requestSnapshot(tenantId, session, turn);
    }
    const host = await this.hostName(tenantId, session.host_id);
    if (name === "SnapshotAnswer") {
      await this.snapshotUnanswered(tenantId, session, turn, host, failedAt);
      await this.evictionSettled(tenantId, sessionId);
      return this.prebuildUnstored(
        tenantId,
        session,
        `host ${host} did not answer the snapshot within ${settings.snapshotDeadlineSeconds} seconds`,
      );
    }
    if (name === "Teardown" && session.state === "Stopping") return this.teardown(tenantId, session, turnId);
    if (name === "TeardownAnswer" && session.state === "Stopping") {
      this.recordStopFailure(
        sessionId,
        "NotAnswered",
        `host ${host} did not answer the teardown of the session's box within ${settings.snapshotDeadlineSeconds} seconds; check that its supervisor runs, then stop the session again`,
        failedAt,
      );
      return this.returnToIdle(tenantId, sessionId);
    }
    if (name === "HostOffline" && turn.state === "Running" && (await this.hostOffline(session.host_id))) {
      return this.failTurn(
        tenantId,
        turnId,
        "HostOffline",
        `host ${host} went offline during the turn and did not reconnect within ${settings.heartbeatDeadlineSeconds} seconds; check that its supervisor runs, then send the turn again`,
        failedAt,
      );
    }
    if (name === "FirstLine" && turn.state === "Running" && turn.line_count === 0) {
      return this.failTurn(
        tenantId,
        turnId,
        "NoFirstOutput",
        `the harness wrote no line for the turn within ${settings.turnFirstLineBudgetSeconds} seconds of its repository being ready; check the box on host ${host}, then send the turn again`,
        failedAt,
      );
    }
    if (name === "Total" && turn.state === "Offered") {
      const [refusal] = this.ctx.storage.sql
        .exec<{ host_id: string; detail: string }>(
          "SELECT host_id, detail FROM turn_refusals WHERE turn_id = ?",
          turnId,
        )
        .toArray();
      if (refusal !== undefined) {
        return this.failTurn(
          tenantId,
          turnId,
          "Undelivered",
          `no host took the turn within ${settings.turnTotalBudgetSeconds} seconds of its first offer, so it never ran; host ${await this.hostName(tenantId, refusal.host_id)} last refused it: ${refusal.detail}`,
          failedAt,
        );
      }
      const presence = (await this.hostOffline(session.host_id)) ? "is offline" : "is online but never claimed it";
      return this.failTurn(
        tenantId,
        turnId,
        "Undelivered",
        `no host took the turn within ${settings.turnTotalBudgetSeconds} seconds of its first offer, so it never ran; host ${host} ${presence}. Check that its supervisor runs and reads Online, then send the turn again`,
        failedAt,
      );
    }
    if (name === "Total" && turn.state === "Running") {
      return this.failTurn(
        tenantId,
        turnId,
        "TurnTimedOut",
        `the turn did not finish within ${settings.turnTotalBudgetSeconds} seconds; send a smaller prompt or raise turnTotalBudgetSeconds`,
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
        `the turn sent lineSeq ${lineSeq}, but the control plane holds lines up to ${held}; the lines in between were lost on the channel, so send the turn again`,
        iso(now),
      );
    }
    const succeeded = successResultOf(HarnessSchema.parse(session.harness))?.(parseJson(text)) === true;
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
      if (succeeded) {
        sql.exec("INSERT OR IGNORE INTO turn_results (turn_id, created_at) VALUES (?, ?)", turn.turn_id, now);
      }
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
      await this.chunks.write(tenantId, session.session_id, turn.turn_id, settingsOf(this.env).transcriptChunkLines);
  }

  private async failTurn(
    tenantId: string,
    turnId: string,
    reason: TurnFailureReason,
    detail: string,
    failedAt: string,
    sessionState: "Idle" | "Failed" | "Stopping" | "Stopped" = "Idle",
  ): Promise<void> {
    const turn = this.turnRow(turnId);
    if (turn === null || !IN_FLIGHT.includes(turn.state)) return;
    const unstored = reason === "SnapshotNotStored" || this.snapshotAsked(turnId);
    const failure = unstored
      ? {
          reason: "SnapshotNotStored" as const,
          detail: `the harness finished the turn, but the snapshot of its work was not stored, so the turn did not complete: ${detail}`,
        }
      : { reason, detail };
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    await this.endTurn(tenantId, turn, now, () => {
      this.recordTurnFailure(turn.session_id, turnId, failure.reason, failure.detail, failedAt, now);
      sql.exec(
        "UPDATE sessions SET state = ?, updated_at = ? WHERE session_id = ?",
        sessionState,
        now,
        turn.session_id,
      );
      this.sessionEntered(turn.session_id, sessionState, now);
    });
    const prebuild = this.hostPrebuild(turn.session_id);
    if (prebuild === null) return;
    const phase = turn.state === "Offered" ? "Dispatch" : "Build";
    const report = {
      phase,
      detail: `turn ${turnId} failed ${failure.reason}: ${failure.detail}`,
      fix: PREBUILD_FIX,
    } as const;
    await this.failPrebuild(tenantId, prebuild.prebuild_id, ["Dispatched", "Building"], report, prebuild.log_url, now);
  }

  private async requestSnapshot(tenantId: string, session: SessionRow, turn: TurnRow): Promise<void> {
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

  private async snapshotUnanswered(
    tenantId: string,
    session: SessionRow,
    turn: TurnRow,
    host: string,
    failedAt: string,
  ): Promise<void> {
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
      const detail = `host ${host} did not answer a snapshot within ${seconds} seconds, and its upload URL has expired; check that its supervisor runs`;
      this.recordSnapshotFailure(request, "NotAnswered", detail, failedAt);
      await this.snapshotNotStored(tenantId, request, detail);
    }
    if (requests.length > 0 && session.state === "Stopping")
      this.setSessionState(session.session_id, "Idle", Date.now());
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
  ): Promise<Refused | null> {
    const sql = this.ctx.storage.sql;
    const [request] = sql
      .exec<SnapshotRequestRow>(
        "SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key FROM snapshot_requests WHERE snapshot_id = ?",
        message.snapshotId,
      )
      .toArray();
    if (request === undefined) {
      if (message.type === "SnapshotDone") await this.lateSnapshotDone(hostId, message.snapshotId);
      return null;
    }
    const session = this.sessionRow(request.session_id);
    if (session?.host_id !== hostId) {
      return refused(
        `host ${hostId} answered snapshot ${message.snapshotId} of tenant ${tenantId}, which it was not asked for`,
      );
    }
    await this.timers(tenantId, request.session_id, { SnapshotAnswer: null });
    if (message.type === "SnapshotFailed") {
      this.recordSnapshotFailure(request, message.reason, message.detail, message.failedAt);
      const detail = `snapshot ${request.snapshot_id} failed ${message.reason}: ${message.detail}`;
      await this.prebuildUnstored(tenantId, session, detail);
      await this.snapshotNotStored(tenantId, request, detail);
      if (session.state === "Stopping" && message.reason === "BoxNotFound") {
        await this.timers(tenantId, session.session_id, { Teardown: { turnId: request.turn_id, at: Date.now() } });
      }
      if (session.state === "Stopping" && message.reason !== "BoxNotFound")
        await this.returnToIdle(tenantId, session.session_id);
      return null;
    }
    if ((await this.env.STORE.head(request.storage_key)) === null) {
      const detail = `host ${await this.hostName(tenantId, hostId)} answered SnapshotDone, but object storage holds no root under ${request.storage_key}; check the host's uploads to object storage`;
      this.recordSnapshotFailure(request, "UploadRejected", detail, iso(Date.now()));
      await this.prebuildUnstored(tenantId, session, detail);
      await this.snapshotNotStored(tenantId, request, detail);
      if (session.state === "Stopping") await this.returnToIdle(tenantId, session.session_id);
      return null;
    }
    const digests = await this.manifestDigests(tenantId, request.storage_key);
    if (digests === null) throw new Error(`snapshot root ${request.storage_key} was stored a moment ago and is gone`);
    const manifest = JSON.stringify(digests);
    const now = Date.now();
    const completes = this.turnRow(request.turn_id)?.state === "Running";
    const state = this.hostPrebuild(request.session_id) === null ? "Idle" : "Stopping";
    const next = this.ctx.storage.transactionSync(() => {
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
      sql.exec(
        "INSERT OR IGNORE INTO snapshot_manifest_chunks (snapshot_id, digest) SELECT ?, value FROM json_each(?)",
        request.snapshot_id,
        manifest,
      );
      sql.exec(
        "DELETE FROM session_chunks WHERE session_id = ? AND digest NOT IN (SELECT value FROM json_each(?))",
        request.session_id,
        manifest,
      );
      if (!completes) return null;
      sql.exec("UPDATE turns SET state = 'Completed', updated_at = ? WHERE turn_id = ?", now, request.turn_id);
      sql.exec("UPDATE sessions SET state = ?, updated_at = ? WHERE session_id = ?", state, now, request.session_id);
      this.appendEvent({ event: "TurnCompleted", turnId: request.turn_id, sessionId: request.session_id }, now);
      this.sessionEntered(request.session_id, state, now);
      sql.exec("DELETE FROM turn_image_fetches WHERE turn_id = ?", request.turn_id);
      sql.exec("DELETE FROM turn_claims WHERE turn_id = ?", request.turn_id);
      releaseConnectorCredentials(sql);
      return this.takeNextWaiting(request.session_id, now);
    });
    await this.prebuildStored(tenantId, request, message.uploadedBytes, now);
    const completed = this.sessionRow(session.session_id);
    if (completes && completed?.state === "Idle" && completed.box_retention === "Off")
      this.startAfterTurnRelease(completed, now);
    if (next !== null) await this.startWaiting(tenantId, request.session_id, next, now);
    if (this.sessionRow(session.session_id)?.state === "Stopping") {
      const latest = this.latestTurn(session.session_id, null);
      if (latest === null)
        throw new Error(`session ${session.session_id} has no turn, though a start always offers one`);
      await this.snapshotOrTeardown(tenantId, session, latest);
    }
    await this.collectSnapshots(tenantId, request, now);
    return null;
  }
}
