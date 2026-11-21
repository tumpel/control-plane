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
  SnapshotRootSchema,
  SnapshotSchema,
  type StartedSessionFromIssueSchema,
  type StartedSessionSchema,
  type SteerSchema,
  StopFailureSchema,
  TranscriptLineSchema,
  TurnFailedEventSchema,
  TurnFailureSchema,
  TurnImageSchema,
  TurnSchema,
  type TurnSendSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { errorOf } from "./backoff.ts";
import { boundedTo, turnFailureDetail } from "./bounded-detail.ts";
import { CONNECTORS_VERSION, TURN_CANCEL_VERSION } from "./channel/control.ts";
import { linesLost } from "./channel/failure.ts";
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
import { type HostRecord, hostOf, hostSilent, listHosts } from "./hosts";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
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
import {
  indexBytesOf,
  LivePacks,
  MAX_INDEX_BYTES,
  MAX_PACKS_PER_MANIFEST,
  type ManifestRead,
  packKey,
  packListKey,
  type SnapshotIndex,
  SnapshotManifests,
} from "./snapshot-manifests.ts";
import { STEER_CONNECTOR_ID, STEER_SETTINGS_PATH, steerSettings } from "./steer.ts";
import {
  clearSupersededFailure,
  forgetSupervisorUpdates,
  restartDeadline,
  type SupervisorUpdateMessage,
} from "./supervisor-updates";
import { appendEvent, type NewTenantEvent } from "./tenant-events.ts";
import {
  ChunkWriter,
  chunksAfter,
  deleteTranscript,
  firstChunkAfter,
  linesWithin,
  type Range,
  type TranscriptLine,
  transcriptPrefix,
} from "./transcript";
import { type Dimensions, offeredDimensions, type TimingMetric, timingBatch } from "./turn-metrics.ts";
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
  origin_trigger_id: string | null;
  origin_delivery_id: string | null;
};

type PersonaRow = {
  secretSetId: string;
  boxMemoryMib: number;
  boxDiskMib: number;
  boxRetention: BoxRetention;
  tumpelMcp: boolean;
};

export type OfferedPrompt = { kind: "Composed"; prompt: string } | { kind: "Uncomposable"; cause: string };

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

type HeldLines = { tenantId: string; sessionId: string; hostId: string; lines: TranscriptLine[] };

type LiveHost = {
  boxCapacity: number;
  channelProtocol: number;
  usage: HostUsage;
  createdAt: number;
  updatedAt: number;
};

type TurnSpan = { first: number; last: number };

type RunningTail = { span: TurnSpan | null; last: number };

type EndedTranscript = { lineCount: number; lastLineSeq: number };

const withChunk = (tail: RunningTail, first: number, last: number): RunningTail => ({
  span:
    tail.span === null
      ? { first, last }
      : { first: Math.min(tail.span.first, first), last: Math.max(tail.span.last, last) },
  last: Math.max(tail.last, last),
});

const linesIn = (tail: RunningTail): number => (tail.span === null ? 0 : tail.span.last - tail.span.first + 1);

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
  o.origin_session_id, o.origin_turn_id, g.trigger_id AS origin_trigger_id, g.delivery_id AS origin_delivery_id
  FROM sessions AS s
  JOIN (${TURN_SELECT}) AS t ON t.turn_id = (SELECT turn_id FROM turns WHERE session_id = s.session_id ORDER BY created_at DESC, turn_id DESC LIMIT 1)
  LEFT JOIN session_issues AS i ON i.session_id = s.session_id
  LEFT JOIN session_box_memory AS m ON m.session_id = s.session_id
  LEFT JOIN session_box_retention AS r ON r.session_id = s.session_id
  LEFT JOIN session_origins AS o ON o.session_id = s.session_id
  LEFT JOIN session_trigger_origins AS g ON g.session_id = s.session_id`;
const SNAPSHOT_SELECT = `SELECT * FROM (
  SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, NULL AS reason, NULL AS detail, NULL AS failed_at, created_at, updated_at FROM snapshots
  UNION ALL
  SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, NULL, reason, detail, failed_at, created_at, created_at FROM snapshot_failures
)`;

const IN_FLIGHT = ["Offered", "Running"];
const PREBUILD_FIX = "Fix what the detail names, then start the prebuild again with rebuild set";
const STORE_DELETE_BATCH = 1000;
const IDLE_EVICTION_MS = 15 * 60 * 1000;

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

const startedByOf = (row: SessionViewRow): SessionStartedBy => {
  if (row.origin_trigger_id !== null && row.origin_delivery_id !== null) {
    return { kind: "Trigger", triggerId: row.origin_trigger_id, deliveryId: row.origin_delivery_id };
  }
  if (row.origin_session_id !== null && row.origin_turn_id !== null) {
    return { kind: "Turn", sessionId: row.origin_session_id, turnId: row.origin_turn_id };
  }
  return { kind: "Person", principalId: row.principal_id };
};

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
    startedBy: startedByOf(row),
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
    ...(row.state === "Failed"
      ? {
          reason: row.reason,
          detail: row.detail === null ? null : turnFailureDetail(row.detail),
          failedAt: row.failed_at,
        }
      : {}),
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
  private readonly heldLines = new Map<string, HeldLines>();
  private readonly runningTails = new Map<string, Promise<RunningTail>>();
  private readonly resentTurns = new Set<string>();
  private readonly heardHosts = new Set<string>();
  private readonly liveHosts = new Map<string, LiveHost>();
  private readonly unreportedBoxes = new Map<string, { hostId: string; boxMemoryMib: number }>();
  private readonly imageFetches = new Map<string, number>();
  private readonly uploadedPacks = new Map<string, Set<string>>();
  private readonly claims = new Map<string, number>();

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
      .exec<StoredSnapshotRow & { prebuild_id: string }>(
        `SELECT snapshots.snapshot_id, snapshots.snapshot_seq, snapshots.storage_key, prebuilds.prebuild_id FROM prebuilds
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
    return { record: { layer: "Prebuild", prebuildId: layer.prebuild_id }, restored: [layer] };
  }

  private readonly manifests = new SnapshotManifests();

  private readonly live = new LivePacks(this.manifests, (after, limit) =>
    this.ctx.storage.sql
      .exec<{ storage_key: string }>(
        "SELECT storage_key FROM snapshots WHERE storage_key > ? ORDER BY storage_key LIMIT ?",
        after,
        limit,
      )
      .toArray()
      .map((row) => row.storage_key),
  );

  private readonly chunks = new ChunkWriter(
    {
      pending: (_tenantId, _sessionId, turnId) => this.heldLines.get(turnId)?.lines ?? [],
      record: (_sessionId, turnId, storageKey, chunk) => {
        const first = chunk.lineSeqs[0];
        const last = chunk.lineSeqs.at(-1);
        if (first === undefined || last === undefined) throw new Error(`transcript chunk ${storageKey} holds no lines`);
        const known = this.runningTails.get(turnId);
        if (known !== undefined)
          this.rememberTail(
            turnId,
            known.then((tail) => withChunk(tail, first, last)),
          );
        const held = this.heldLines.get(turnId);
        if (held === undefined) return;
        held.lines = held.lines.filter((line) => line.lineSeq > last);
        if (held.lines.length === 0) this.heldLines.delete(turnId);
      },
    },
    this.env.STORE,
  );

  private sessionRow(sessionId: string): SessionRow | null {
    const [row] = this.ctx.storage.sql.exec<SessionRow>(`${SESSION_SELECT} WHERE session_id = ?`, sessionId).toArray();
    return row ?? null;
  }

  private rememberTail(turnId: string, tail: Promise<RunningTail>): Promise<RunningTail> {
    this.runningTails.set(turnId, tail);
    const forget = (): void => {
      if (this.runningTails.get(turnId) === tail) this.runningTails.delete(turnId);
    };
    tail.then(undefined, forget);
    return tail;
  }

  private runningTail(tenantId: string, turn: TurnRow): Promise<RunningTail> {
    return this.runningTails.get(turn.turn_id) ?? this.rememberTail(turn.turn_id, this.listRunningTail(tenantId, turn));
  }

  private async listRunningTail(tenantId: string, turn: TurnRow): Promise<RunningTail> {
    const session = this.sessionRow(turn.session_id);
    if (session === null) throw new Error(`turn ${turn.turn_id} runs in session ${turn.session_id}, which is gone`);
    const chunks = await chunksAfter(
      this.env.STORE,
      transcriptPrefix(tenantId, turn.session_id),
      session.last_line_seq,
    );
    let tail: RunningTail = { span: null, last: session.last_line_seq };
    for (const chunk of chunks) {
      tail =
        chunk.turnId === turn.turn_id
          ? withChunk(tail, chunk.firstLineSeq, chunk.lastLineSeq)
          : { span: tail.span, last: Math.max(tail.last, chunk.lastLineSeq) };
    }
    return tail;
  }

  private async lineCount(tenantId: string, turn: TurnRow): Promise<number> {
    if (turn.state !== "Running") return turn.line_count;
    return linesIn(await this.runningTail(tenantId, turn));
  }

  private async lastLineSeq(tenantId: string, session: SessionRow, turn: TurnRow): Promise<number> {
    if (turn.state !== "Running") return session.last_line_seq;
    return (await this.runningTail(tenantId, turn)).last;
  }

  private async endedTranscript(tenantId: string, turn: TurnRow): Promise<EndedTranscript> {
    if (turn.state !== "Running") {
      const session = this.sessionRow(turn.session_id);
      if (session === null) throw new Error(`turn ${turn.turn_id} ends in session ${turn.session_id}, which is gone`);
      return { lineCount: turn.line_count, lastLineSeq: session.last_line_seq };
    }
    const tail = await this.runningTail(tenantId, turn);
    return { lineCount: linesIn(tail), lastLineSeq: tail.last };
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

  private inFlightTurns(sessionId: string): { turn_id: string; state: string; offer_sent: number }[] {
    return this.ctx.storage.sql
      .exec<{ turn_id: string; state: string; offer_sent: number }>(
        `SELECT turn_id, state, offer_sent FROM turns WHERE session_id = ? AND state IN (${IN_FLIGHT.map(() => "?").join(", ")})
        ORDER BY created_at, turn_id`,
        sessionId,
        ...IN_FLIGHT,
      )
      .toArray();
  }

  private latestTurn(sessionId: string, state: string | null): TurnRow | null {
    const [row] = this.ctx.storage.sql
      .exec<TurnRow>(
        `${TURN_SELECT} AS v WHERE v.session_id = ?1 AND (?2 IS NULL OR v.state = ?2)
        AND NOT (v.state IN ('Offered', 'Running') AND EXISTS (
          SELECT 1 FROM turns AS older WHERE older.session_id = v.session_id AND older.state IN ('Offered', 'Running')
          AND (older.created_at, older.turn_id) < (v.created_at, v.turn_id)))
        ORDER BY v.created_at DESC, v.turn_id DESC LIMIT 1`,
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

  protected offeredPrompt(harness: string, turn: TurnRow): OfferedPrompt {
    return { kind: "Composed", prompt: offerPrompt(harness, turn) };
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
      .then((offer) => (offer === null ? null : this.host(session.host_id).send(offer)))
      .then((sent) => {
        if (sent === "Sent") this.offerSent(turn.turn_id);
      })
      .catch((error: unknown) => {
        console.error(
          `OfferQueued: turn ${turn.turn_id} did not reach host ${session.host_id} and waits for its next heartbeat: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.offering.delete(turn.turn_id));
  }

  private async offerAfter(tenantId: string, session: SessionRow, turn: TurnRow, victims: HeldBox[]): Promise<void> {
    if (victims.length === 0) return this.offer(tenantId, session, turn);
    if ((await this.armOffer(tenantId, session, turn)) === null) return;
    const now = Date.now();
    for (const victim of victims) {
      const evicted = this.sessionRow(victim.sessionId);
      if (evicted === null) throw new Error(`session ${victim.sessionId} was picked for eviction and then not found`);
      await this.startBoxEviction(tenantId, evicted, now);
    }
  }

  private async startBoxEviction(tenantId: string, evicted: SessionRow, now: number): Promise<void> {
    if (evicted.state !== "Idle") return;
    const latest = this.latestTurn(evicted.session_id, null);
    if (latest === null) throw new Error(`session ${evicted.session_id} has no turn, though a start always offers one`);
    this.setSessionState(evicted.session_id, "Stopping", now);
    await this.timers(tenantId, evicted.session_id, { Snapshot: null });
    await this.snapshotOrTeardown(tenantId, { ...evicted, state: "Stopping" }, latest);
  }

  protected waitingTurns(sessionId: string): string[] {
    return this.inFlightTurns(sessionId)
      .slice(1)
      .map((row) => row.turn_id);
  }

  private nextQueued(sessionId: string): string | null {
    const [head] = this.inFlightTurns(sessionId);
    if (head === undefined || head.state !== "Offered") return null;
    if (head.offer_sent === 1 || this.offering.has(head.turn_id)) return null;
    return head.turn_id;
  }

  protected takeNextWaiting(sessionId: string, now: number): string | null {
    const next = this.nextQueued(sessionId);
    if (next === null) return null;
    const session = this.sessionRow(sessionId);
    if (session === null) throw new Error(`session ${sessionId} vanished while turn ${next} waited for it`);
    if (session.state === "Failed") {
      const detail =
        "the session could not clone its repository before the turn started, so it never ran; archive the session and start a new one on a repository that exists";
      for (const { turn_id: turnId } of this.inFlightTurns(sessionId)) {
        this.cancelWaiting(sessionId, turnId, "RepositoryCloneFailed", detail, now);
      }
      return null;
    }
    return next;
  }

  protected async startWaiting(tenantId: string, sessionId: string, turnId: string, now: number): Promise<void> {
    if (this.sessionRow(sessionId)?.state !== "Stopping") return this.runQueued(tenantId, turnId);
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
    this.recordTurnFailure(sessionId, turnId, reason, detail, iso(now), 0, now);
  }

  private recordTurnFailure(
    sessionId: string,
    turnId: string,
    reason: TurnFailureReason,
    fullDetail: string,
    failedAt: string,
    lineCount: number,
    now: number,
  ): void {
    const sql = this.ctx.storage.sql;
    const detail = turnFailureDetail(fullDetail);
    sql.exec(
      "UPDATE turns SET state = 'Failed', line_count = ?, updated_at = ? WHERE turn_id = ?",
      lineCount,
      now,
      turnId,
    );
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
    const [ended] = this.ctx.storage.sql
      .exec<{ at: number | null }>(
        `SELECT MAX(updated_at) AS at FROM turns WHERE session_id = ? AND state NOT IN (${IN_FLIGHT.map(() => "?").join(", ")})
        AND (created_at, turn_id) < (?, ?)`,
        turn.session_id,
        ...IN_FLIGHT,
        turn.created_at,
        turn.turn_id,
      )
      .toArray();
    return Math.max(turn.created_at, ended?.at ?? 0);
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
      if ((await this.host(handoff.hostId).send(handoff.offer)) === "Sent") this.offerSent(turnId);
      return;
    }
    if (session.state !== "Stopped") return;
    const hosts = await listHosts(this.env, tenantId);
    const image = await this.imageAvailability(session.harness, session.harness_version, now);
    if (this.turnRow(turnId)?.state !== "Offered" || this.sessionRow(session.session_id)?.state !== "Stopped") return;
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
    if (this.sessionRow(sessionId)?.state === "Stopping") return;
    const next = this.nextQueued(sessionId);
    if (next !== null) await this.runQueued(tenantId, next);
  }

  protected offerSent(turnId: string): void {
    this.ctx.storage.sql.exec("UPDATE turns SET offer_sent = 1 WHERE turn_id = ? AND state = 'Offered'", turnId);
  }

  private async armOffer(tenantId: string, session: SessionRow, turn: TurnRow): Promise<StoredTurnOffer | null> {
    const offer = await this.composeOffer(tenantId, session, turn);
    if (offer === null) return null;
    await this.timers(tenantId, session.session_id, {
      FirstLine: null,
      Total: { turnId: turn.turn_id, at: this.budgetStart(turn) + settingsOf(this.env).turnTotalBudgetSeconds * 1000 },
      Snapshot: null,
      Teardown: null,
      HostOffline: null,
    });
    return offer;
  }

  private async composeOffer(tenantId: string, session: SessionRow, turn: TurnRow): Promise<StoredTurnOffer | null> {
    const composed = this.offerMessage(session, turn);
    if (composed.kind === "Composed") return composed.offer;
    const detail = `the turn's offer could not be composed, so it never reached a host; report this to the tumpel maintainers, then send the turn again: ${composed.cause}`;
    await this.failTurn(
      tenantId,
      turn.turn_id,
      "Undelivered",
      boundedTo(TurnFailedEventSchema.shape.detail.maxLength, detail),
      iso(Date.now()),
    );
    return null;
  }

  private offerMessage(
    session: SessionRow,
    turn: TurnRow,
  ): { kind: "Composed"; offer: StoredTurnOffer } | { kind: "Uncomposable"; cause: string } {
    const prompt = this.offeredPrompt(session.harness, turn);
    if (prompt.kind === "Uncomposable") return prompt;
    const [ran] = this.ctx.storage.sql
      .exec(
        "SELECT 1 FROM turns WHERE session_id = ? AND box_id = ? AND turn_id != ? LIMIT 1",
        session.session_id,
        session.box_id,
        turn.turn_id,
      )
      .toArray();
    if (ran === undefined && !this.unreportedBoxes.has(session.box_id)) {
      this.unreportedBoxes.set(session.box_id, { hostId: session.host_id, boxMemoryMib: session.box_memory_mib });
    }
    const prebuild = this.hostPrebuild(session.session_id);
    const offer: StoredTurnOffer = {
      type: "TurnOffer",
      turnId: turn.turn_id,
      sessionId: session.session_id,
      boxId: session.box_id,
      repository: session.repository,
      harness: SessionSchema.shape.harness.parse(session.harness),
      harnessVersion: session.harness_version,
      model: session.model,
      prompt: prompt.prompt,
      boxMemoryMib: session.box_memory_mib,
      boxDiskMib: session.box_disk_mib,
      ...(prebuild === null ? {} : { prebuildCommitSha: prebuild.head_sha }),
    };
    return { kind: "Composed", offer };
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
    this.keepHostUsage(hostId, boxCapacity, usage, now, channelProtocol);
    this.ctx.storage.sql.exec("UPDATE turns SET offer_sent = 0 WHERE host_id = ? AND state = 'Offered'", hostId);
    this.heardHosts.add(hostId);
    clearSupersededFailure(this.ctx.storage.sql, hostId);
  }

  private keepHostUsage(
    hostId: string,
    boxCapacity: number,
    usage: HostUsage,
    now: number,
    channelProtocol: number,
  ): void {
    this.liveHosts.set(hostId, {
      boxCapacity,
      channelProtocol,
      usage,
      createdAt: this.liveHosts.get(hostId)?.createdAt ?? now,
      updatedAt: now,
    });
    this.forgetUnreportedBoxes(hostId);
  }

  private forgetUnreportedBoxes(hostId: string): void {
    for (const [boxId, offer] of this.unreportedBoxes) {
      if (offer.hostId === hostId) this.unreportedBoxes.delete(boxId);
    }
  }

  protected async hostUsage(hostId: string, usage: HostUsage, now: number): Promise<void> {
    await this.flushHeldLines(hostId);
    const known = this.liveHosts.get(hostId);
    if (known === undefined) {
      throw new Error(
        `host ${hostId} reported usage to a tenant that restarted since the host's hello; the host must reconnect so its box capacity is known again`,
      );
    }
    this.keepHostUsage(hostId, known.boxCapacity, usage, now, known.channelProtocol);
  }

  private runsTurns(hostId: string): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ turn_id: string }>("SELECT turn_id FROM turns WHERE host_id = ? AND state = ? LIMIT 1", hostId, "Running")
      .toArray();
    return row !== undefined;
  }

  private async flushHeldLines(hostId: string): Promise<void> {
    if (!this.heardHosts.has(hostId)) {
      this.heardHosts.add(hostId);
      if (this.runsTurns(hostId))
        throw linesLost(
          `host ${hostId} runs a turn, and this tenant restarted since it last heard from the host, so lines it held for that turn may be gone; the host resends them`,
        );
    }
    const held = [...this.heldLines].filter(([, lines]) => lines.hostId === hostId);
    for (const [turnId, lines] of held) await this.storeLines(lines.tenantId, lines.sessionId, turnId, 1);
  }

  private async storeLines(tenantId: string, sessionId: string, turnId: string, minLines: number): Promise<boolean> {
    const refused = await this.writeLines(tenantId, sessionId, turnId, minLines);
    if (refused === null) return true;
    await this.failTurn(
      tenantId,
      turnId,
      "TranscriptGap",
      `TranscriptNotStored: the transcript store refused the lines of this turn, so the control plane dropped them; send the turn again: ${refused}`,
      iso(Date.now()),
    );
    return false;
  }

  private async writeLines(
    tenantId: string,
    sessionId: string,
    turnId: string,
    minLines: number,
  ): Promise<string | null> {
    return this.chunks.write(tenantId, sessionId, turnId, minLines).then(
      () => null,
      (error: unknown) => {
        const dropped = this.heldLines.get(turnId)?.lines.length ?? 0;
        this.heldLines.delete(turnId);
        const detail = errorOf(error).message;
        console.error(
          `TranscriptNotStored: the transcript store refused the lines of turn ${turnId}, so the control plane dropped ${dropped} held lines and fails the turn: ${detail}`,
        );
        return detail;
      },
    );
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
    for (const sessionId of heldSessionIds) {
      if (this.sessionRow(sessionId)?.host_id === hostId) await this.armIdleEviction(tenantId, sessionId);
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
      this.setSessionState(session.session_id, "Stopping", now);
      await this.timers(tenantId, session.session_id, { Snapshot: null });
      await this.snapshotOrTeardown(tenantId, { ...session, state: "Stopping" }, latest);
    }
  }

  protected forgetHostUsage(hostId: string): void {
    this.liveHosts.delete(hostId);
    this.forgetUnreportedBoxes(hostId);
    forgetSupervisorUpdates(this.ctx.storage.sql, hostId);
  }

  protected runningTurnsByHost(): RunningTurns[] {
    return this.ctx.storage.sql
      .exec<{ host_id: string; running: number }>(
        `SELECT t.host_id, COUNT(DISTINCT t.session_id) AS running FROM turns t JOIN sessions s ON s.session_id = t.session_id
        WHERE t.state IN (${IN_FLIGHT.map(() => "?").join(", ")}) AND s.state != 'Stopped' GROUP BY t.host_id`,
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
            AND NOT EXISTS (
              SELECT 1 FROM stop_failures x WHERE x.session_id = s.session_id
                AND x.created_at >= COALESCE((SELECT MAX(t.updated_at) FROM turns t WHERE t.session_id = s.session_id), 0)
                AND NOT EXISTS (SELECT 1 FROM snapshots p WHERE p.session_id = s.session_id AND p.updated_at > x.created_at)
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
    const running = new Map(this.runningTurnsByHost().map((each) => [each.hostId, each.runningTurns]));
    const unreported = new Map<string, number>();
    for (const offer of this.unreportedBoxes.values()) {
      unreported.set(offer.hostId, (unreported.get(offer.hostId) ?? 0) + offer.boxMemoryMib);
    }
    return [...this.liveHosts]
      .sort(([leftId, left], [rightId, right]) => left.createdAt - right.createdAt || leftId.localeCompare(rightId))
      .map(([hostId, live]) => ({
        hostId,
        tenantId,
        boxCapacity: live.boxCapacity,
        boxesRunning: running.get(hostId) ?? 0,
        boxesWarm: live.usage.boxesWarm,
        loadAverage: live.usage.loadAverage,
        memoryAvailableMib: live.usage.memoryAvailableMib,
        ...(live.usage.diskBudgetMib === undefined || live.usage.diskHeldMib === undefined
          ? {}
          : { diskBudgetMib: live.usage.diskBudgetMib, diskHeldMib: live.usage.diskHeldMib }),
        ...(live.usage.memoryBudgetMib === undefined || live.usage.memoryHeldMib === undefined
          ? {}
          : {
              memoryBudgetMib: live.usage.memoryBudgetMib,
              memoryHeldMib: live.usage.memoryHeldMib + (unreported.get(hostId) ?? 0),
            }),
        channelProtocol: live.channelProtocol,
        createdAt: live.createdAt,
        updatedAt: live.updatedAt,
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
    const placed = placeSession(
      input.hosts,
      this.listHostUsage(tenantId),
      image.image,
      { boxMemoryMib, boxDiskMib },
      uses.length > 0 || persona.tumpelMcp,
      this.heldBoxes(),
    );
    const placement = placed;
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
      const first = this.newTurn(session.session_id, session.host_id, session.box_id, { prompt: start.prompt }, now);
      return first;
    });
    await this.offerAfter(tenantId, session, turn, placement.evict);
    return {
      kind: "Started",
      started: { session: this.presentSession(tenantId, session.session_id), turn: toTurn(tenantId, turn) },
    };
  }

  private sendWaiting(tenantId: string, session: SessionRow, send: TurnSend, now: number): Sent {
    const turn = this.ctx.storage.transactionSync(() =>
      this.newTurn(session.session_id, session.host_id, session.box_id, send, now),
    );
    return { kind: "Sent", turn: toTurn(tenantId, turn) };
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
    if (session.state === "Stopping") return { kind: "Stopping" };
    if (session.state === "Failed") return { kind: "Failed" };
    const refusal = this.refusedCredential(session, now);
    if (refusal !== null) return { kind: "CredentialRefused", personaId: session.persona_id, refusal };
    const uses = sessionConnectorUses(this.ctx.storage.sql, sessionId);
    const unusable = uses.filter((use) => !use.usable).map((use) => use.name);
    if (unusable.length > 0) return { kind: "ConnectorDisconnected", names: unusable };
    if (await deployDraining(this.env.RELEASES)) return { kind: "Draining" };
    if (this.inFlightTurns(sessionId).length > 0) return this.sendWaiting(tenantId, session, send, now);
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
    if (this.inFlightTurns(sessionId).length > 0) return this.sendWaiting(tenantId, session, send, now);
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

  private async offerElsewhere(tenantId: string, session: SessionRow, turn: TurnRow): Promise<TurnHandoff | null> {
    return this.placeOffered(tenantId, session, turn, false, await listHosts(this.env, tenantId));
  }

  private async placeOffered(
    tenantId: string,
    session: SessionRow,
    turn: TurnRow,
    staying: boolean,
    listed: readonly HostRecord[],
  ): Promise<TurnHandoff | null> {
    const now = Date.now();
    const stay = (): null => null;
    const movable = this.unsnapshottedTurns(session.session_id).length === 0;
    const prebuild = this.hostPrebuild(session.session_id) !== null;
    const hosts = listed.filter(
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
      const offer = await this.armOffer(tenantId, session, turn);
      if (offer === null) return null;
      return { type: "TurnHandoff", hostId: session.host_id, offer };
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
    if (offer === null) return null;
    return { type: "TurnHandoff", hostId, offer };
  }

  private async evictFirst(tenantId: string, session: SessionRow, turn: TurnRow, victims: HeldBox[]): Promise<null> {
    await this.offerAfter(tenantId, session, turn, victims);
    return null;
  }

  protected async deferredOffers(tenantId: string, hostId: string): Promise<TurnHandoff[]> {
    const turnIds = this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        `SELECT t.turn_id FROM turns AS t JOIN sessions AS s ON s.session_id = t.session_id
        WHERE t.state = 'Offered' AND t.offer_sent = 0 AND s.host_id = ?
          AND NOT EXISTS (SELECT 1 FROM turns AS older WHERE older.session_id = t.session_id
            AND older.state IN ('Offered', 'Running') AND (older.created_at, older.turn_id) < (t.created_at, t.turn_id))
        ORDER BY t.created_at, t.turn_id`,
        hostId,
      )
      .toArray()
      .map((row) => row.turn_id);
    if (turnIds.length === 0) return [];
    const hosts = await listHosts(this.env, tenantId);
    const handoffs: TurnHandoff[] = [];
    for (const turnId of turnIds) {
      const handoff = await this.offerDeferred(tenantId, turnId, hosts);
      if (handoff !== null) handoffs.push(handoff);
    }
    return handoffs;
  }

  private async offerDeferred(
    tenantId: string,
    turnId: string,
    hosts: readonly HostRecord[],
  ): Promise<TurnHandoff | null> {
    if (this.offering.has(turnId)) return null;
    const turn = this.turnRow(turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null || turn.state !== "Offered") return null;
    this.offering.add(turnId);
    try {
      if (session.state !== "Stopped") return await this.placeOffered(tenantId, session, turn, true, hosts);
      await this.runQueued(tenantId, turnId);
      return null;
    } finally {
      this.offering.delete(turnId);
    }
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
      return this.newTurn(session.session_id, hostId, boxId, send, now);
    });
  }

  private steerRows(turnId: string): Steer[] {
    const turn = this.turnRow(turnId);
    const ended = turn !== null && turn.state !== "Running" && turn.state !== "Offered";
    return this.ctx.storage.sql
      .exec<{ steer_id: string; prompt: string; created_at: number; delivered: number }>(
        "SELECT steer_id, prompt, created_at, delivered FROM steers WHERE turn_id = ? ORDER BY created_at, steer_id",
        turnId,
      )
      .toArray()
      .map((row) => {
        const state: SteerState = row.delivered === 1 ? "Delivered" : ended ? "TurnEnded" : "Pending";
        return { steerId: row.steer_id, turnId, prompt: row.prompt, state, createdAt: row.created_at };
      });
  }

  protected async steerTurn(tenantId: string, turnId: string, prompt: string, now: number): Promise<SteerSent> {
    const turn = this.getTurn(tenantId, turnId);
    if (turn === null) return { kind: "NotFound" };
    if (turn.state !== "Running") return { kind: "NotRunning", state: turn.state };
    const sql = this.ctx.storage.sql;
    const session = this.sessionRow(turn.sessionId);
    if (session === null) throw new Error(`turn ${turnId} has no session ${turn.sessionId}`);
    if (session.harness !== "ClaudeCode" || this.channelProtocol(session.host_id) < CONNECTORS_VERSION) {
      return { kind: "Unsupported" };
    }
    if (this.hostPrebuild(session.session_id) !== null) return { kind: "Unsupported" };
    const [held] = sql
      .exec<{ digest: string }>(
        "SELECT digest FROM persona_files WHERE persona_id = ? AND path = ?",
        session.persona_id,
        STEER_SETTINGS_PATH,
      )
      .toArray();
    if ((await this.mergedSteerSettings(tenantId, session, held?.digest ?? null)) === null) {
      return { kind: "Unsupported" };
    }
    if (this.turnRow(turnId)?.state !== "Running") return { kind: "NotRunning", state: turn.state };
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

  protected takeSteers(turnId: string): SteersTaken {
    return this.ctx.storage.transactionSync(() => {
      if (this.turnRow(turnId)?.state !== "Running") return { kind: "Closed" };
      const pending = this.steerRows(turnId).filter((steer) => steer.state === "Pending");
      for (const steer of pending) {
        this.ctx.storage.sql.exec("UPDATE steers SET delivered = 1 WHERE steer_id = ?", steer.steerId);
      }
      return { kind: "Taken", prompts: pending.map((steer) => steer.prompt) };
    });
  }

  private async mergedSteerSettings(
    tenantId: string,
    session: SessionRow,
    digest: string | null,
  ): Promise<string | null> {
    const blob = digest === null ? null : await this.env.STORE.get(personaFileKey(tenantId, digest));
    if (digest !== null && blob === null) {
      throw new Error(
        `persona file ${STEER_SETTINGS_PATH} of session ${session.session_id} is gone from object storage`,
      );
    }
    return steerSettings(blob === null ? null : await blob.text());
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
    const merged = await this.mergedSteerSettings(tenantId, session, held?.digest ?? null);
    if (merged === null) return null;
    const bytes = new Uint8Array(new TextEncoder().encode(merged));
    const digest = await sha256Hex(bytes);
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
    const running = this.inFlightTurns(sessionId)[0]?.turn_id ?? null;
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
    const live = this.liveHosts.get(hostId);
    if (live === undefined) throw new Error(`host ${hostId} runs a turn but never said hello`);
    return live.channelProtocol;
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
        "SELECT storage_key FROM snapshot_requests WHERE session_id = ?1 UNION SELECT storage_key FROM snapshot_failures WHERE session_id = ?1 AND storage_key != ''",
        sessionId,
      )
      .toArray()
      .flatMap((row) => [row.storage_key, packListKey(row.storage_key)]);
    const stored = this.storedSnapshots("WHERE session_id = ?", sessionId);
    const freed = await this.live.release(
      this.env.STORE,
      tenantId,
      stored.map((snapshot) => snapshot.storage_key),
    );
    await this.deleteObjects([...keys, ...this.objectKeys(stored)]);
    await this.deleteFreedPacks(tenantId, freed);
    this.ctx.storage.transactionSync(() => {
      this.releaseSnapshots(stored);
      sql.exec("DELETE FROM snapshot_failures WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM snapshot_requests WHERE session_id = ?", sessionId);
    });
    return { kind: "Archived", session: this.presentSession(tenantId, sessionId) };
  }

  protected async deleteSession(tenantId: string, sessionId: string, now: number): Promise<SessionDeleted> {
    const archived = await this.archiveSession(tenantId, sessionId, now);
    if (archived.kind !== "Archived") return archived;
    const sql = this.ctx.storage.sql;
    const [held] = sql.exec("SELECT 1 FROM snapshots WHERE session_id = ? LIMIT 1", sessionId).toArray();
    if (held !== undefined) return { kind: "NotStopped", state: "Archived" };
    await deleteTranscript(this.env.STORE, transcriptPrefix(tenantId, sessionId));
    sql.exec("DELETE FROM sessions WHERE session_id = ?", sessionId);
    return { kind: "Deleted" };
  }

  private async collectSnapshots(tenantId: string, stored: SnapshotRequestRow, now: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const failed = sql
      .exec<{ storage_key: string }>(
        "SELECT storage_key FROM snapshot_failures WHERE session_id = ? AND snapshot_seq < ? AND storage_key != ''",
        stored.session_id,
        stored.snapshot_seq,
      )
      .toArray()
      .flatMap((row) => [row.storage_key, packListKey(row.storage_key)]);
    const older = this.storedSnapshots(
      "WHERE session_id = ? AND snapshot_seq < ?",
      stored.session_id,
      stored.snapshot_seq,
    );
    const freed = await this.live.release(
      this.env.STORE,
      tenantId,
      older.map((snapshot) => snapshot.storage_key),
    );
    await this.deleteObjects([...this.objectKeys(older), ...failed]);
    await this.deleteFreedPacks(tenantId, freed);
    this.ctx.storage.transactionSync(() => this.releaseSnapshots(older));
    await this.archiveSupersededPrebuilds(tenantId, now);
  }

  private releaseSnapshots(snapshots: { snapshot_id: string; storage_key: string }[]): void {
    for (const snapshot of snapshots) {
      this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE snapshot_id = ?", snapshot.snapshot_id);
      this.manifests.forget(snapshot.storage_key);
    }
  }

  private objectKeys(snapshots: { storage_key: string }[]): string[] {
    return snapshots.flatMap((snapshot) => [snapshot.storage_key, packListKey(snapshot.storage_key)]);
  }

  private deleteFreedPacks(tenantId: string, packDigests: string[]): Promise<void> {
    return this.deleteObjects(packDigests.map((packDigest) => packKey(tenantId, packDigest)));
  }

  private async deleteObjects(keys: string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += STORE_DELETE_BATCH) {
      await this.env.STORE.delete(keys.slice(start, start + STORE_DELETE_BATCH));
    }
  }

  private storedSnapshots(
    select: string,
    ...params: SqlStorageValue[]
  ): { snapshot_id: string; storage_key: string }[] {
    return this.ctx.storage.sql
      .exec<{ snapshot_id: string; storage_key: string }>(
        `SELECT snapshot_id, storage_key FROM snapshots ${select}`,
        ...params,
      )
      .toArray();
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

  private async armIdleEviction(tenantId: string, sessionId: string): Promise<void> {
    const session = this.sessionRow(sessionId);
    if (session?.state !== "Idle" || session.box_retention !== "Auto" || this.inFlightTurns(sessionId).length > 0)
      return;
    const latest = this.latestTurn(sessionId, null);
    if (latest === null) throw new Error(`session ${sessionId} has no turn, though a start always offers one`);
    const sql = this.ctx.storage.sql;
    const [pending] = sql.exec("SELECT 1 FROM snapshot_requests WHERE session_id = ? LIMIT 1", sessionId).toArray();
    if (pending !== undefined) return;
    const [stored] = sql
      .exec<{ created_at: number }>(
        "SELECT created_at FROM snapshots WHERE session_id = ? AND turn_id = ? ORDER BY created_at DESC LIMIT 1",
        sessionId,
        latest.turn_id,
      )
      .toArray();
    if (stored !== undefined) {
      return this.timers(tenantId, sessionId, {
        Teardown: { turnId: latest.turn_id, at: stored.created_at + IDLE_EVICTION_MS },
      });
    }
    const [failed] = sql
      .exec("SELECT 1 FROM snapshot_failures WHERE session_id = ? AND turn_id = ? LIMIT 1", sessionId, latest.turn_id)
      .toArray();
    if (failed !== undefined) return;
    await this.timers(tenantId, sessionId, {
      Snapshot: { turnId: latest.turn_id, at: latest.updated_at + settingsOf(this.env).snapshotDelaySeconds * 1000 },
    });
  }

  private snapshotHolds(sessionId: string, turnId: string): boolean {
    const sql = this.ctx.storage.sql;
    const [pending] = sql.exec("SELECT 1 FROM snapshot_requests WHERE session_id = ? LIMIT 1", sessionId).toArray();
    const [stored] = sql
      .exec("SELECT 1 FROM snapshots WHERE session_id = ? AND turn_id = ? LIMIT 1", sessionId, turnId)
      .toArray();
    return pending === undefined && stored !== undefined;
  }

  private async evictIdle(tenantId: string, session: SessionRow, turn: TurnRow): Promise<void> {
    if (await this.hostOffline(session.host_id)) return;
    if (this.latestTurn(session.session_id, null)?.turn_id !== turn.turn_id) return;
    if (this.heldBoxes().find((held) => held.sessionId === session.session_id)?.evictable !== true) return;
    if (!this.snapshotHolds(session.session_id, turn.turn_id)) return;
    await this.startBoxEviction(tenantId, session, Date.now());
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
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        "INSERT INTO stop_failures (stop_failure_id, session_id, reason, detail, failed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        sessionId,
        reason,
        detail,
        failedAt,
        Date.now(),
      );
    });
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
        AND (?5 IS NULL OR g.trigger_id = ?5)
        ORDER BY s.created_at, s.session_id`,
        filter.state ?? null,
        filter.hostId ?? null,
        filter.lastTurnBefore ?? null,
        JSON.stringify(filter.tags ?? []),
        filter.triggerId ?? null,
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
    return this.turnRows(sessionId).map((row) => toTurn(tenantId, row, this.turnImage(row.turn_id)));
  }

  private turnRows(sessionId: string): TurnRow[] {
    return this.ctx.storage.sql
      .exec<TurnRow>(`${TURN_SELECT} WHERE session_id = ? ORDER BY created_at, turn_id`, sessionId)
      .toArray();
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
      detail: turnFailureDetail(row.detail),
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

  protected async transcriptCursor(
    tenantId: string,
    sessionId: string,
    after: number,
    turnId: string | null,
    limit: number,
    maxBytes: number | null,
  ): Promise<TranscriptCursor | null> {
    const session = this.sessionRow(sessionId);
    if (session === null) return null;
    const turns = this.turnRows(sessionId);
    const index = turnId === null ? -1 : turns.findIndex((turn) => turn.turn_id === turnId);
    const read = turnId === null ? turns : turns.slice(index, index + 1);
    const running = read.find((turn) => turn.state === "Running");
    const tail = running === undefined ? null : await this.runningTail(tenantId, running);
    const before = turns.slice(0, Math.max(index, 0)).reduce((lines, turn) => lines + turn.line_count, 0);
    const ended = turnId === null ? session.last_line_seq : before + (read[0]?.line_count ?? 0);
    const held = [...this.heldLines]
      .filter(([heldTurnId, lines]) => lines.sessionId === sessionId && (turnId === null || heldTurnId === turnId))
      .flatMap(([, lines]) => lines.lines);
    const known = {
      sessionState: SessionSchema.shape.state.parse(session.state),
      harness: SessionSchema.shape.harness.parse(session.harness),
      lastLineSeq: Math.max(held.at(-1)?.lineSeq ?? 0, tail?.last ?? ended),
      inFlight: read.some((turn) => IN_FLIGHT.includes(turn.state)),
    };
    const start = Math.max(after, before);
    const chunk =
      read.length === 0 || start >= known.lastLineSeq
        ? null
        : await firstChunkAfter(this.env.STORE, transcriptPrefix(tenantId, sessionId), start);
    if (chunk !== null && (turnId === null || chunk.turnId === turnId))
      return { ...known, kind: "Chunk", storageKey: chunk.storageKey, range: { offset: 0, length: chunk.size } };
    const page = held.filter((line) => line.lineSeq > after).slice(0, limit);
    return { ...known, kind: "Lines", lines: linesWithin(page, maxBytes) };
  }

  protected turnMetricDimensions(turnIds: readonly string[]): Record<string, Dimensions> {
    const entries = turnIds.flatMap((turnId): [string, Dimensions][] => {
      const turn = this.turnRow(turnId);
      const session = turn === null ? null : this.sessionRow(turn.session_id);
      const persona = session === null ? null : this.personaRow(session.persona_id);
      if (session === null || persona === null) return [];
      return [[turnId, offeredDimensions(session.persona_id, persona.secretSetId)]];
    });
    return Object.fromEntries(entries);
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

  protected async failHostWork(tenantId: string, hostId: string, detail: string, now: number): Promise<void> {
    const running = this.ctx.storage.sql
      .exec<{ turn_id: string }>("SELECT turn_id FROM turns WHERE host_id = ? AND state = 'Running'", hostId)
      .toArray();
    for (const { turn_id } of running) {
      await this.failTurn(tenantId, turn_id, "RateLimited", detail, iso(now));
      if (this.channelProtocol(hostId) >= TURN_CANCEL_VERSION)
        await this.host(hostId).send({ type: "TurnCancel", turnId: turn_id });
    }
    const requests = this.ctx.storage.sql
      .exec<SnapshotRequestRow>(
        `SELECT r.snapshot_id, r.session_id, r.box_id, r.turn_id, r.snapshot_seq, r.storage_key
        FROM snapshot_requests r JOIN sessions s ON s.session_id = r.session_id WHERE s.host_id = ?`,
        hostId,
      )
      .toArray();
    for (const request of requests) {
      this.recordSnapshotFailure(request, "RateLimited", detail, iso(now));
      await this.timers(tenantId, request.session_id, { SnapshotAnswer: null });
      await this.snapshotNotStored(tenantId, request, detail);
      if (this.sessionRow(request.session_id)?.state === "Stopping")
        this.setSessionState(request.session_id, "Idle", Date.now());
    }
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
    return row?.state === "Offline" || (row?.state === "Online" && (await hostSilent(this.env, hostId)));
  }

  protected async hostMessage(
    tenantId: string,
    hostId: string,
    message: SessionHostMessage,
  ): Promise<HostReply | null> {
    if (message.type !== "TurnLine") await this.flushHeldLines(hostId);
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

  private async restorableIndex(tenantId: string, sessionId: string): Promise<ManifestRead<SnapshotIndex> | null> {
    const sql = this.ctx.storage.sql;
    const [restorable] = [
      ...sql
        .exec<{ storage_key: string }>(
          "SELECT storage_key FROM snapshots WHERE session_id = ? ORDER BY snapshot_seq DESC LIMIT 1",
          sessionId,
        )
        .toArray(),
      ...sql
        .exec<{ storage_key: string }>(
          `SELECT snapshots.storage_key FROM session_prebuild_layers JOIN prebuild_sessions USING (prebuild_id)
          JOIN snapshots ON snapshots.session_id = prebuild_sessions.session_id
          WHERE session_prebuild_layers.session_id = ? ORDER BY snapshots.snapshot_seq DESC LIMIT 1`,
          sessionId,
        )
        .toArray(),
    ];
    if (restorable === undefined) return null;
    return this.manifests.index(this.env.STORE, tenantId, restorable.storage_key);
  }

  private async snapshotChunks(
    tenantId: string,
    hostId: string,
    message: Extract<ChunkAsk, { type: "SnapshotChunks" }>,
  ): Promise<ChunkReply | Refused | null> {
    const window = this.snapshotUploadWindow(tenantId, hostId, message.snapshotId);
    if (window === null || "type" in window) return window;
    const index = await this.restorableIndex(tenantId, window.request.session_id);
    const held = index?.kind === "Read" ? index.value : null;
    return {
      type: "SnapshotChunksHeld",
      snapshotId: message.snapshotId,
      part: message.part,
      held: [...new Set(message.digests)].sort().flatMap((digest) => held?.find(digest) ?? []),
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
    const named = await this.live.names(this.env.STORE, tenantId);
    const missing = message.packs.filter((pack) => !named.has(pack.packDigest));
    const uploading = this.uploadedPacks.get(message.snapshotId) ?? new Set<string>();
    for (const pack of missing) uploading.add(pack.packDigest);
    this.uploadedPacks.set(message.snapshotId, uploading);
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
    const index = await this.restorableIndex(tenantId, session.session_id);
    if (index !== null && index.kind !== "Read") {
      throw new Error(`session ${session.session_id} restores a snapshot that is unreadable: ${index.detail}`);
    }
    const asked = new Map<string, boolean>();
    for (const chunk of message.chunks) {
      asked.set(
        chunk.packDigest,
        (asked.get(chunk.packDigest) ?? true) && index?.kind === "Read" && index.value.holds(chunk),
      );
    }
    const held = [...asked]
      .filter(([, all]) => all)
      .map(([packDigest]) => packDigest)
      .sort();
    const heads = await Promise.all(held.map((packDigest) => this.env.STORE.head(packKey(tenantId, packDigest))));
    const packs = held.flatMap((packDigest, at) => {
      const head = heads[at];
      return head === null || head === undefined ? [] : [{ pack_digest: packDigest, size_bytes: head.size }];
    });
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
      this.unreportedBoxes.delete(turn.box_id);
      this.ctx.storage.sql.exec(
        `INSERT INTO turn_refusals (turn_id, host_id, detail, refused_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (turn_id) DO UPDATE SET host_id = excluded.host_id, detail = excluded.detail, refused_at = excluded.refused_at`,
        turn.turn_id,
        hostId,
        message.detail,
        now,
      );
      this.ctx.storage.sql.exec("UPDATE turns SET offer_sent = 0 WHERE turn_id = ?", turn.turn_id);
      return null;
    }
    if (message.reason === "HostUpdating" && turn.state === "Offered")
      return this.offerElsewhere(tenantId, session, turn);
    const handedOver =
      message.reason === "HostUpdating" && turn.state === "Running" && (await this.lineCount(tenantId, turn)) === 0;
    if (handedOver || (message.reason === "NotClaimed" && IN_FLIGHT.includes(turn.state))) {
      this.ctx.storage.sql.exec(
        "UPDATE turns SET state = 'Offered', offer_sent = 0, updated_at = ? WHERE turn_id = ?",
        now,
        turn.turn_id,
      );
      const offeredAgain = { ...turn, state: "Offered" as const };
      if (handedOver) return null;
      return this.composeOffer(tenantId, session, offeredAgain);
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
    const elsewhere = this.turnRow(message.turnId);
    if (elsewhere !== null && elsewhere.host_id !== hostId) return { type: "TurnWithdrawn", turnId: elsewhere.turn_id };
    const offered = this.offeredTurn(hostId, message);
    if (offered.type === "Refused") return offered;
    const { turn, session } = offered;
    if (turn.state !== "Offered") {
      if (session.state === "Stopped" && session.box_id === turn.box_id) {
        await this.host(hostId).send({ type: "BoxDiscard", sessionId: session.session_id, boxId: turn.box_id });
      }
      return { type: "TurnWithdrawn", turnId: turn.turn_id };
    }
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("UPDATE turns SET state = 'Running', updated_at = ? WHERE turn_id = ?", now, turn.turn_id);
      sql.exec("UPDATE sessions SET state = 'Running', updated_at = ? WHERE session_id = ?", now, session.session_id);
      this.appendEvent({ event: "TurnStarted", turnId: turn.turn_id, sessionId: session.session_id }, now);
      sql.exec(
        `UPDATE prebuilds SET state = 'Building', updated_at = ?1 WHERE state = 'Dispatched'
        AND prebuild_id IN (SELECT prebuild_id FROM prebuild_sessions WHERE session_id = ?2)`,
        now,
        session.session_id,
      );
    });
    this.claims.set(turn.turn_id, now);
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
    const fetchStartedAt = this.imageFetches.get(offered.turn.turn_id);
    this.imageFetches.delete(offered.turn.turn_id);
    const reply = await handle();
    if (fetchStartedAt === undefined) return reply;
    const { turn, session } = offered;
    await this.recordTiming(tenantId, "turn.image_fetch.duration", turn, session, fetchStartedAt, now);
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
      this.imageFetches.set(turn.turn_id, now);
      return;
    }
    if (message.type === "TurnRepositoryReady") {
      if (turn.state !== "Running" || (await this.lineCount(tenantId, turn)) > 0) return;
      const settings = settingsOf(this.env);
      return this.timers(tenantId, session.session_id, {
        FirstLine: { turnId: turn.turn_id, at: now + settings.turnFirstLineBudgetSeconds * 1000 },
      });
    }
    if (turn.state !== "Running") return;
    if (message.type === "TurnLine") {
      const claimedAt =
        !this.heldLines.has(turn.turn_id) && (await this.lineCount(tenantId, turn)) === 0
          ? this.claims.get(turn.turn_id)
          : undefined;
      this.claims.delete(turn.turn_id);
      await this.appendLine(tenantId, session, turn, message.lineSeq, message.text, now);
      if (claimedAt === undefined) return;
      return this.recordTiming(tenantId, "turn.first_output.duration", turn, session, claimedAt, now);
    }
    const held = await this.lastLineSeq(tenantId, session, turn);
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
    if (!(await this.storeLines(tenantId, session.session_id, turn.turn_id, 1))) return;
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
      .exec<{ result_printed: number }>("SELECT result_printed FROM turns WHERE turn_id = ?", turnId)
      .toArray();
    return row?.result_printed === 1;
  }

  private async endTurn(
    tenantId: string,
    turn: TurnRow,
    now: number,
    record: (ended: EndedTranscript) => void,
  ): Promise<void> {
    await this.writeLines(tenantId, turn.session_id, turn.turn_id, 1);
    const ended = await this.endedTranscript(tenantId, turn);
    const next = this.ctx.storage.transactionSync(() => {
      record(ended);
      this.imageFetches.delete(turn.turn_id);
      this.claims.delete(turn.turn_id);
      releaseConnectorCredentials(this.ctx.storage.sql);
      return this.takeNextWaiting(turn.session_id, now);
    });
    this.runningTails.delete(turn.turn_id);
    const session = this.sessionRow(turn.session_id);
    const release = session?.state === "Idle" && session.box_retention === "Off";
    if (release) this.setSessionState(session.session_id, "Stopping", now);
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
    if (name === "Teardown" && session.state === "Idle") return this.evictIdle(tenantId, session, turn);
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
    if (name === "FirstLine" && turn.state === "Running" && (await this.lineCount(tenantId, turn)) === 0) {
      return this.failTurn(
        tenantId,
        turnId,
        "NoFirstOutput",
        `the harness wrote no line for the turn within ${settings.turnFirstLineBudgetSeconds} seconds of its repository being ready; check the box on host ${host}, then send the turn again`,
        failedAt,
      );
    }
    if (name === "Total" && turn.state === "Offered" && session.state === "Stopped") {
      return this.failTurn(
        tenantId,
        turnId,
        "Undelivered",
        `no host of your tenant had room for the session's new box within ${settings.turnTotalBudgetSeconds} seconds of the turn's start, so it never ran; wait for running turns to finish, raise boxCapacity in runtime.json or enrol another host, then send the turn again`,
        failedAt,
        "Stopped",
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
    const held = this.heldLines.get(turn.turn_id);
    const last = held?.lines.at(-1)?.lineSeq ?? (await this.lastLineSeq(tenantId, session, turn));
    if (lineSeq <= last) return;
    if (lineSeq > last + 1 && held === undefined && !this.resentTurns.has(turn.turn_id)) {
      this.resentTurns.add(turn.turn_id);
      throw linesLost(
        `turn ${turn.turn_id} sent lineSeq ${lineSeq}, but this tenant holds lines up to ${last}; it restarted before it stored the lines in between, so the host resends them`,
      );
    }
    if (lineSeq > last + 1) {
      return this.failTurn(
        tenantId,
        turn.turn_id,
        "TranscriptGap",
        `the turn sent lineSeq ${lineSeq}, but the control plane holds lines up to ${last}; the lines in between were lost on the channel, so send the turn again`,
        iso(now),
      );
    }
    if (successResultOf(HarnessSchema.parse(session.harness))?.(parseJson(text)) === true) {
      this.ctx.storage.sql.exec("UPDATE turns SET result_printed = 1 WHERE turn_id = ?", turn.turn_id);
    }
    const chunkLines = settingsOf(this.env).transcriptChunkLines;
    if (
      (held?.lines.length ?? 0) >= chunkLines &&
      !(await this.storeLines(tenantId, session.session_id, turn.turn_id, chunkLines))
    )
      return;
    const line = toLine(tenantId, {
      session_id: session.session_id,
      line_seq: lineSeq,
      turn_id: turn.turn_id,
      text,
      created_at: now,
    });
    const holding = this.heldLines.get(turn.turn_id);
    if (holding !== undefined) holding.lines.push(line);
    else
      this.heldLines.set(turn.turn_id, {
        tenantId,
        sessionId: session.session_id,
        hostId: turn.host_id,
        lines: [line],
      });
    if (holding === undefined && (await this.lineCount(tenantId, turn)) === 0)
      await this.timers(tenantId, session.session_id, { FirstLine: null });
    if ((this.heldLines.get(turn.turn_id)?.lines.length ?? 0) >= chunkLines)
      await this.storeLines(tenantId, session.session_id, turn.turn_id, chunkLines);
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
    await this.endTurn(tenantId, turn, now, (ended) => {
      this.recordTurnFailure(turn.session_id, turnId, failure.reason, failure.detail, failedAt, ended.lineCount, now);
      const unborn = sessionState === "Idle" && turn.state === "Offered" && this.boxUnborn(turn);
      const entered = unborn ? "Stopped" : sessionState;
      if (unborn) this.unreportedBoxes.delete(turn.box_id);
      sql.exec(
        "UPDATE sessions SET state = ?, last_line_seq = ?, updated_at = ? WHERE session_id = ?",
        entered,
        ended.lastLineSeq,
        now,
        turn.session_id,
      );
      this.sessionEntered(turn.session_id, entered, now);
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

  private boxUnborn(turn: TurnRow): boolean {
    return (
      this.ctx.storage.sql
        .exec(
          `SELECT 1 FROM sessions WHERE session_id = ?1 AND box_id = ?2
          AND NOT EXISTS (SELECT 1 FROM turns WHERE session_id = ?1 AND box_id = ?2 AND turn_id != ?3 AND state != 'Offered')`,
          turn.session_id,
          turn.box_id,
          turn.turn_id,
        )
        .toArray().length > 0
    );
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

  private async snapshotChecked(
    tenantId: string,
    hostId: string,
    request: SnapshotRequestRow,
  ): Promise<
    | { kind: "Rejected"; detail: string }
    | { kind: "Checked"; packs: ReadonlySet<string>; rootPacks: ReadonlySet<string> }
  > {
    const rejected = async (detail: string) => ({
      kind: "Rejected" as const,
      detail: `host ${await this.hostName(tenantId, hostId)} ${detail}`,
    });
    const root = await this.env.STORE.get(request.storage_key);
    if (root === null) {
      return rejected(
        `answered SnapshotDone, but object storage holds no root under ${request.storage_key}; check the host's uploads to object storage`,
      );
    }
    const parsed = SnapshotRootSchema.safeParse(await root.json());
    if (!parsed.success) {
      return rejected(
        `stored snapshot root ${request.storage_key}, which is no snapshot root: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      );
    }
    const indexBytes = indexBytesOf(parsed.data.manifest);
    if (indexBytes > MAX_INDEX_BYTES) {
      return rejected(
        `stored a snapshot under ${request.storage_key} whose chunk index would take ${indexBytes} bytes, above the ${MAX_INDEX_BYTES} bytes the control plane holds, so the session keeps its previous snapshot; remove large generated trees from the workspace before the next turn`,
      );
    }
    const named = await this.manifests.packs(this.env.STORE, tenantId, request.storage_key);
    if (named.kind !== "Read") {
      return rejected(
        `stored snapshot ${request.snapshot_id} with a manifest the control plane cannot read, so it could never restore it and the session keeps its previous snapshot: ${named.detail}`,
      );
    }
    if (named.value.size > MAX_PACKS_PER_MANIFEST) {
      return rejected(
        `stored snapshot ${request.snapshot_id} with chunks in ${named.value.size} packs, above the ${MAX_PACKS_PER_MANIFEST} the control plane indexes, so the session keeps its previous snapshot`,
      );
    }
    return {
      kind: "Checked",
      packs: named.value,
      rootPacks: new Set(parsed.data.manifest.map((placement) => placement.packDigest)),
    };
  }

  private async snapshotOutcome(
    tenantId: string,
    hostId: string,
    request: SnapshotRequestRow,
    uploadedBytes: number,
  ): Promise<
    | { kind: "Rejected"; detail: string }
    | { kind: "Answered" }
    | { kind: "Stored"; now: number; completes: boolean; next: string | null }
  > {
    const storageFailed = (error: unknown): string =>
      `object storage failed while the control plane checked snapshot ${request.snapshot_id}, so the session keeps its previous snapshot: ${errorOf(error).message}`;
    const checked = await this.snapshotChecked(tenantId, hostId, request).catch(
      (error: unknown): { kind: "Rejected"; detail: string } => ({ kind: "Rejected", detail: storageFailed(error) }),
    );
    if (checked.kind === "Rejected") return checked;
    const turn = this.turnRow(request.turn_id);
    const ended = turn === null ? null : await this.endedTranscript(tenantId, turn);
    const uploaded = this.uploadedPacks.get(request.snapshot_id) ?? new Set<string>();
    const reused = new Set(
      [...checked.packs].filter((packDigest) => !uploaded.has(packDigest) && !checked.rootPacks.has(packDigest)),
    );
    const claimed = await this.live.claim(this.env.STORE, tenantId, request.storage_key, checked.packs, reused).then(
      (gone) => ({ gone }),
      (error: unknown) => ({ failed: storageFailed(error) }),
    );
    if ("failed" in claimed) return { kind: "Rejected", detail: claimed.failed };
    if (claimed.gone !== null) {
      return {
        kind: "Rejected",
        detail: `snapshot ${request.snapshot_id} reuses pack ${claimed.gone}, which no stored snapshot names any longer, so the session keeps its previous snapshot`,
      };
    }
    const [stillPending] = this.ctx.storage.sql
      .exec("SELECT 1 FROM snapshot_requests WHERE snapshot_id = ?", request.snapshot_id)
      .toArray();
    if (stillPending === undefined) {
      await this.live.release(this.env.STORE, tenantId, [request.storage_key]);
      return { kind: "Answered" };
    }
    return { kind: "Stored", ...this.storeSnapshot(request, uploadedBytes, ended) };
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
  ): Promise<Refused | null> {
    const sql = this.ctx.storage.sql;
    const [request] = sql
      .exec<SnapshotRequestRow>(
        "SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key FROM snapshot_requests WHERE snapshot_id = ?",
        message.snapshotId,
      )
      .toArray();
    if (request === undefined) return null;
    const session = this.sessionRow(request.session_id);
    if (session?.host_id !== hostId) {
      return refused(
        `host ${hostId} answered snapshot ${message.snapshotId} of tenant ${tenantId}, which it was not asked for`,
      );
    }
    if (message.type === "SnapshotFailed") {
      this.uploadedPacks.delete(request.snapshot_id);
      await this.timers(tenantId, request.session_id, { SnapshotAnswer: null });
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
    const outcome = await this.snapshotOutcome(tenantId, hostId, request, message.uploadedBytes);
    this.uploadedPacks.delete(request.snapshot_id);
    if (outcome.kind === "Answered") return null;
    if (outcome.kind === "Rejected") {
      await this.timers(tenantId, request.session_id, { SnapshotAnswer: null });
      this.recordSnapshotFailure(request, "UploadRejected", outcome.detail, iso(Date.now()));
      await this.prebuildUnstored(tenantId, session, outcome.detail);
      await this.snapshotNotStored(tenantId, request, outcome.detail);
      if (session.state === "Stopping") await this.returnToIdle(tenantId, session.session_id);
      return null;
    }
    const { now, completes, next } = outcome;
    await this.timers(tenantId, request.session_id, { SnapshotAnswer: null });
    await this.prebuildStored(tenantId, request, message.uploadedBytes, now);
    const completed = this.sessionRow(session.session_id);
    if (completes && completed?.state === "Idle" && completed.box_retention === "Off")
      this.setSessionState(completed.session_id, "Stopping", now);
    if (next !== null) await this.startWaiting(tenantId, request.session_id, next, now);
    await this.armIdleEviction(tenantId, request.session_id);
    if (this.sessionRow(session.session_id)?.state === "Stopping") {
      const latest = this.latestTurn(session.session_id, null);
      if (latest === null)
        throw new Error(`session ${session.session_id} has no turn, though a start always offers one`);
      await this.snapshotOrTeardown(tenantId, session, latest);
    }
    await this.collectSnapshots(tenantId, request, now);
    return null;
  }

  private storeSnapshot(
    request: SnapshotRequestRow,
    uploadedBytes: number,
    ended: EndedTranscript | null,
  ): { now: number; completes: boolean; next: string | null } {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const completes = this.turnRow(request.turn_id)?.state === "Running";
    const state = this.hostPrebuild(request.session_id) === null ? "Idle" : "Stopping";
    const next = this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM snapshot_requests WHERE snapshot_id = ?", request.snapshot_id);
      sql.exec(
        "INSERT INTO snapshots (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        request.snapshot_id,
        request.session_id,
        request.box_id,
        request.turn_id,
        request.snapshot_seq,
        request.storage_key,
        uploadedBytes,
        now,
        now,
      );
      if (!completes || ended === null) return null;
      sql.exec(
        "UPDATE turns SET state = 'Completed', line_count = ?, updated_at = ? WHERE turn_id = ?",
        ended.lineCount,
        now,
        request.turn_id,
      );
      sql.exec(
        "UPDATE sessions SET state = ?, last_line_seq = ?, updated_at = ? WHERE session_id = ?",
        state,
        ended.lastLineSeq,
        now,
        request.session_id,
      );
      this.appendEvent({ event: "TurnCompleted", turnId: request.turn_id, sessionId: request.session_id }, now);
      this.sessionEntered(request.session_id, state, now);
      this.imageFetches.delete(request.turn_id);
      this.claims.delete(request.turn_id);
      releaseConnectorCredentials(sql);
      return this.takeNextWaiting(request.session_id, now);
    });
    if (completes) this.runningTails.delete(request.turn_id);
    return { now, completes, next };
  }
}
