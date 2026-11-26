import { DurableObject } from "cloudflare:workers";
import { MCP_PATH } from "@tumpel/api/constants";
import { checkModelCredential, credentialProblem, dispatchVariables, type SecretMember } from "@tumpel/api/credentials";
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
  SessionStateSchema,
  type SessionTagsOverLimitSchema,
  type SessionTagsPatchSchema,
  type SetSessionTagsResultSchema,
  SnapshotRootSchema,
  SnapshotSchema,
  type StartedSessionFromIssueSchema,
  type StartedSessionSchema,
  type SteerSchema,
  StopFailureSchema,
  TranscriptLineSchema,
  TurnCredentialRefusedSchema,
  TurnFailedEventSchema,
  TurnFailureSchema,
  TurnImageSchema,
  TurnSchema,
  type TurnSendSchema,
} from "@tumpel/schemas";
import { eq, inArray, sql as query } from "drizzle-orm";
import type { z } from "zod";
import { errorOf } from "./backoff.ts";
import { boundedTo, turnFailureDetail } from "./bounded-detail.ts";
import type {
  BootImage,
  DispatchConnector,
  HostMessage,
  HostReportedHealth,
  PersonaFileDownload,
  PreparedOffer,
  ReportedUsage,
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
import { durableDb } from "./db/client.ts";
import * as tenantSchema from "./db/tenant-schema.ts";
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
import { type HostEntry, type HostRecord, hostOf, listHosts, type OfferSent, withReportedHealth } from "./hosts";
import type { Env } from "./index";
import { keyStoreOf } from "./key-store.ts";
import { PackCleanup } from "./pack-cleanup.ts";
import { personaFileKey, sha256Hex } from "./persona-files";
import {
  type BoxSize,
  degradedOnly,
  type HeldBox,
  type HostHeadroom,
  type ImageAvailability,
  placeSession,
  type ReportedHostUsage,
  roomFreed,
  sessionFreesRoom,
  shortOf,
  type Unplaceable,
} from "./placement";
import { signerOf } from "./presign";
import { bootArchitectures, bootFor, bootImage, type ReleaseRead, readRelease } from "./releases";
import { type MemberRow, storedKeys, toMember } from "./secret-members.ts";
import { why } from "./sessions.ts";
import { presenceGraceMs, settingsOf, turnCredentialSeconds } from "./settings";
import {
  draftKey,
  heldPlacements,
  indexKey,
  MAX_INDEX_BYTES,
  mergedDraft,
  packKey,
  packList,
  packListKey,
  STORE_DELETE_BATCH,
  snapshotDraft,
} from "./snapshot-manifests.ts";
import { STEER_CONNECTOR_ID, STEER_SETTINGS_PATH, steerSettings } from "./steer.ts";
import { clearSupersededFailure, forgetSupervisorUpdates, type SupervisorUpdateMessage } from "./supervisor-updates";
import type { TenantInput } from "./tenant-api.ts";
import { appendEvent, type NewTenantEvent } from "./tenant-events.ts";
import {
  chunkKey,
  chunksAfter,
  deleteTranscript,
  encodeChunk,
  firstChunkAfter,
  type Range,
  type TranscriptLine,
  transcriptPrefix,
} from "./transcript";
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

export type SessionStarted<T> = Started<T> | z.infer<typeof SessionTagsOverLimitSchema>;

type ImageLookup = { kind: "Read"; image: ImageAvailability } | ReleaseUnreadable;

type CredentialRefusal = z.infer<typeof TurnCredentialRefusedSchema>["refusal"];

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

type SendRefusal = Exclude<Sent, { kind: "Sent" }>;

export type Claim = () => SendRefusal | null;

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
  | { kind: "Archived" };

export type Archive =
  | { kind: "Archived"; session: Session }
  | { kind: "NotFound" }
  | { kind: "NotStopped"; state: SessionState };

export type SessionDeleted = { kind: "Deleted"; triggerIds: string[] } | Exclude<Archive, { kind: "Archived" }>;

export type TranscriptCursor = {
  sessionState: SessionState;
  harness: Session["harness"];
  lastLineSeq: number;
  inFlight: boolean;
} & ({ kind: "Chunk"; storageKey: string; range: Range } | { kind: "Lines" });

type UnheldTurnRow = { turn_id: string; state: string; offer_sent: number; unheld_heartbeats: number };

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

type HostReportRow = {
  host_id: string;
  box_capacity: number;
  channel_protocol: number;
  memory_budget_mib: number;
  memory_held_mib: number;
  memory_available_mib: number;
  disk_budget_mib: number;
  disk_held_mib: number;
  load_average: number;
  reported_health: HostReportedHealth;
  heard_at: number;
  created_at: number;
  boxes_running: number;
  boxes_warm: number;
  boxes_memory_mib: number;
  boxes_disk_mib: number;
};

const HEARD_REFRESH_MS = 30_000;

export type HostReport = {
  boxCapacity: number;
  channelProtocol: number;
  usage: ReportedUsage;
  now: number;
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

const BOX_IDLE_SECONDS = 15 * 60;
const IN_FLIGHT = ["Offered", "Running"];
const PREBUILD_FIX = "Fix what the detail names, then start the prebuild again with rebuild set";

export type TenantHostMessage = Exclude<HostMessage, SupervisorUpdateMessage>;
export type SessionHostMessage = Exclude<TenantHostMessage, { type: "ClaudeSetupBoxUrl" | "ClaudeSetupBoxFailed" }>;
type ChunkAsk = Extract<
  SessionHostMessage,
  { type: "SnapshotChunks" | "SnapshotChunkCheck" | "SnapshotIndexAsk" | "SnapshotPacks" | "RestoreChunks" }
>;
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
  {
    type:
      | "SnapshotChunksHeld"
      | "SnapshotChunkCheckHeld"
      | "SnapshotIndexUpload"
      | "SnapshotPackUploads"
      | "RestoreDownloads";
  }
>;
type StoredTurnOffer = Extract<StoredControlMessage, { type: "TurnOffer" }>;
type Handoff = { hostId: string; offer: StoredTurnOffer };
type TurnHandoff = Handoff & { type: "TurnHandoff" };
type StaleHosts = ReadonlyMap<string, number>;
const NONE_STALE: StaleHosts = new Map();
const UNKNOWN_SESSION_STATES: readonly string[] = ["Starting", "Running", "Idle", "Stopping"];
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
  stale: StaleHosts,
): Session => {
  const lastTurn = toTurn(
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
    stale,
  );
  const heardAt = UNKNOWN_SESSION_STATES.includes(row.state) ? stale.get(row.host_id) : undefined;
  return SessionSchema.parse({
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
    ...(heardAt === undefined ? { state: row.state } : { state: "Unknown", heardAt: iso(heardAt) }),
    lastTurnId: row.last_turn_id,
    lastTurnState: lastTurn.state,
    lastTurnAt: new Date(row.last_turn_at).toISOString(),
    lastTurn,
    lastTurnImage: lastTurnImage ?? undefined,
    prebuildLayer: prebuildLayer ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
};

const unknownTurnDetail = (hostId: string, heardAt: number): string =>
  `host ${hostId} has not reported to the control plane since ${iso(heardAt)}, so the state of this turn is unknown until it reports again; check that its supervisor runs and reaches the control plane`;

const turnState = (row: TurnRow, stale: StaleHosts): Record<string, unknown> => {
  const heardAt = IN_FLIGHT.includes(row.state) ? stale.get(row.host_id) : undefined;
  if (heardAt !== undefined)
    return { state: "Unknown", heardAt: iso(heardAt), detail: unknownTurnDetail(row.host_id, heardAt) };
  if (row.state === "Failed")
    return {
      state: row.state,
      reason: row.reason,
      detail: row.detail === null ? null : turnFailureDetail(row.detail),
      failedAt: row.failed_at,
    };
  if (row.state === "Completed" && row.warning !== null) return { state: row.state, warning: row.warning };
  return { state: row.state };
};

const toTurn = (tenantId: string, row: TurnRow, image: TurnImage | null, stale: StaleHosts): Turn =>
  TurnSchema.parse({
    turnId: row.turn_id,
    tenantId,
    sessionId: row.session_id,
    boxId: row.box_id,
    prompt: row.prompt,
    ...(row.goal === null ? {} : { goal: row.goal }),
    ...turnState(row, stale),
    lineCount: row.line_count,
    image: image ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const undelivered = (host: string, sent: Exclude<OfferSent, "Sent"> | Error): [TurnFailureReason, string] => {
  if (sent instanceof Error)
    return [
      "Undelivered",
      `the turn did not reach host ${host}, so it never ran; check that its supervisor runs, then send the turn again: ${sent.message}`,
    ];
  if (sent === "Offline")
    return [
      "Undelivered",
      `host ${host} is offline, so the turn never reached it; check that its supervisor runs, then send the turn again`,
    ];
  if (sent === "Degraded")
    return [
      "HostDegraded",
      `host ${host} missed its heartbeat and counts as Degraded, so the turn never reached it; check that its supervisor runs and reaches the control plane, then send the turn again`,
    ];
  return [
    "RateLimited",
    `host ${host} is rate limited and takes no offers, so the turn never reached it; send the turn again once its health recovers`,
  ];
};

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
  private readonly runningTails = new Map<string, Promise<RunningTail>>();
  private readonly dispatchingOffers = new Set<string>();

  protected abstract failPrebuild(
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

  private async prebuildUnstored(session: SessionRow, detail: string): Promise<void> {
    const prebuild = this.hostPrebuild(session.session_id);
    if (prebuild === null) return;
    const report = { phase: "Upload" as const, detail, fix: PREBUILD_FIX };
    if (!(await this.failPrebuild(prebuild.prebuild_id, ["Building"], report, prebuild.log_url, Date.now()))) return;
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

  private prebuildLayer(session: SessionRow, host: HostEntry, release: ReleaseRead): PrebuildLayer {
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

  private readonly cleanup = new PackCleanup();

  protected async cleanPacks(): Promise<void> {
    const tenantId = this.ctx.id.name;
    if (tenantId === undefined) throw new Error("the tenant Durable Object cleaning packs has no name");
    await this.cleanup.step(this.ctx, this.env.STORE, tenantId, Date.now());
  }

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
    } else if (state === "Stopped") this.appendEvent({ event: "SessionStopped", sessionId }, now);
    else if (state === "Failed") this.appendEvent({ event: "SessionFailed", sessionId }, now);
    else if (state === "Archived") this.appendEvent({ event: "SessionArchived", sessionId }, now);
    else return;
    if (!this.hasUnsignaledRoomWait()) return;
    const code = sessionFreesRoom(state, state === "Idle" ? this.heldBoxes(sessionId)[0] : undefined);
    const session = this.sessionRow(sessionId);
    if (session === null) throw new Error(`session ${sessionId} vanished before its capacity signal`);
    if (code !== null) this.appendEvent({ event: "CapacityAvailable", hostId: session.host_id, code }, now);
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
    return checked.kind === "Usable" ? null : TurnCredentialRefusedSchema.shape.refusal.parse(checked);
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

  protected host(hostId: string) {
    return this.env.HOST.get(this.env.HOST.idFromName(hostId));
  }

  private async offer(tenantId: string, session: SessionRow, turn: TurnRow): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE turns SET offer_sent = 1, unheld_heartbeats = 0 WHERE turn_id = ?", turn.turn_id);
    const offer = await this.armOffer(tenantId, session, turn);
    if (offer === null) return;
    const refused = this.reportRefusesOffer(session.host_id, Date.now());
    if (refused !== null) return this.sendSettled(tenantId, turn.turn_id, session.host_id, refused);
    await this.dispatchOffer(tenantId, turn.turn_id, session.host_id, offer);
  }

  private async dispatchOffer(tenantId: string, turnId: string, hostId: string, offer: StoredTurnOffer): Promise<void> {
    this.dispatchingOffers.add(turnId);
    const sent = await this.host(hostId)
      .send(offer)
      .finally(() => {
        this.dispatchingOffers.delete(turnId);
      })
      .catch((error: unknown) => errorOf(error));
    await this.sendSettled(tenantId, turnId, hostId, sent);
  }

  private reportRefusesOffer(hostId: string, now: number): "RateLimited" | "Degraded" | null {
    const [row] = this.ctx.storage.sql
      .exec<{ reported_health: string; heard_at: number }>(
        "SELECT reported_health, heard_at FROM host_reports WHERE host_id = ?",
        hostId,
      )
      .toArray();
    if (row === undefined) return null;
    if (row.reported_health === "RateLimited") return "RateLimited";
    return row.heard_at < now - presenceGraceMs(settingsOf(this.env)) ? "Degraded" : null;
  }

  private async offerAfter(tenantId: string, session: SessionRow, turn: TurnRow, victims: HeldBox[]): Promise<void> {
    if (victims.length === 0) return this.offer(tenantId, session, turn);
    this.ctx.storage.sql.exec("UPDATE turns SET offer_sent = 0 WHERE turn_id = ?", turn.turn_id);
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
    if (head.offer_sent === 1) return null;
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

  protected async startWaiting(tenantId: string, sessionId: string, turnId: string): Promise<void> {
    if (this.sessionRow(sessionId)?.state !== "Stopping") return this.runQueued(tenantId, turnId);
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
    if (session.state === "Idle") return this.offer(tenantId, move(session.host_id, session.box_id), turn);
    if (session.state !== "Stopped") return;
    const hosts = await this.hostRecords(tenantId);
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
        this.heldBoxes(),
        now - presenceGraceMs(settingsOf(this.env)),
      );
    const stays = place(hosts.filter((host) => host.hostId === session.host_id && host.state === "Online"));
    const placement = stays.kind === "Placed" && stays.evict.length === 0 ? stays : place(hosts);
    if (placement.kind === "Refused" && degradedOnly(placement.hosts)) {
      const detail = `the session's box was released while the turn waited, and no host of your tenant is healthy: ${placement.hosts.map(why).join(", ")}`;
      return this.failTurn(tenantId, turnId, "HostDegraded", detail, iso(now), "Stopped");
    }
    if (placement.kind === "Refused") {
      const detail = `the session's box was released while the turn waited, and no host has room for a new one: ${placement.hosts.map(why).join(", ")}`;
      return this.failTurn(tenantId, turnId, "PoolExhausted", detail, iso(now), "Stopped");
    }
    await this.offerAfter(tenantId, move(placement.host.hostId, crypto.randomUUID()), turn, placement.evict);
  }

  private async evictionSettled(tenantId: string, sessionId: string): Promise<void> {
    const settled = this.sessionRow(sessionId);
    if (settled?.state === "Stopping") return;
    const next = this.nextQueued(sessionId);
    if (next !== null) await this.runQueued(tenantId, next);
    if (settled !== null) await this.offerRoomed(tenantId, settled.host_id, "Wait");
  }

  private async offerRoomed(tenantId: string, hostId: string, onShort: "Wait" | "Fail"): Promise<void> {
    for (;;) {
      const [waiting] = this.ctx.storage.sql
        .exec<{ turn_id: string }>(
          `SELECT t.turn_id FROM turns t JOIN sessions s ON s.session_id = t.session_id
          WHERE t.host_id = ?1 AND t.state = 'Offered' AND t.offer_sent = 0
            AND s.host_id = t.host_id AND s.box_id = t.box_id AND s.state IN ('Starting', 'Running')
            AND NOT EXISTS (
              SELECT 1 FROM turns e WHERE e.session_id = t.session_id AND e.state IN ('Offered', 'Running')
                AND (e.created_at, e.turn_id) < (t.created_at, t.turn_id)
            )
          ORDER BY t.created_at, t.turn_id LIMIT 1`,
          hostId,
        )
        .toArray();
      if (waiting === undefined) return;
      const turn = this.turnRow(waiting.turn_id);
      const session = turn === null ? null : this.sessionRow(turn.session_id);
      if (turn === null || session === null)
        throw new Error(`turn ${waiting.turn_id} vanished while it waited for room`);
      const usage = this.hostUsageWithout(tenantId, session.session_id).find((each) => each.hostId === hostId);
      if (usage === undefined) return;
      const box = boxSizeOf(session);
      const short = shortOf(usage, box);
      if (short === null) {
        await this.offer(tenantId, session, turn);
        continue;
      }
      if (onShort === "Wait" || this.stoppingOn(hostId)) return;
      const host = await this.hostName(tenantId, hostId);
      const held =
        short === "Memory"
          ? `${usage.memoryBudgetMib} MiB of memory and its other boxes hold ${usage.memoryHeldMib} MiB of it, so this turn's box of ${box.boxMemoryMib} MiB`
          : `${usage.diskBudgetMib} MiB of disk and its other boxes hold ${usage.diskHeldMib} MiB of it, so this turn's box disk of ${box.boxDiskMib} MiB`;
      const detail = `the idle boxes were asked to make room for this turn, and host ${host} is still short of ${short.toLowerCase()}: it gives boxes ${held} does not fit; send the turn again`;
      await this.failTurn(tenantId, turn.turn_id, "PoolExhausted", detail, iso(Date.now()));
    }
  }

  private stoppingOn(hostId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec("SELECT 1 FROM sessions WHERE host_id = ? AND state = ? LIMIT 1", hostId, "Stopping")
        .toArray().length > 0
    );
  }

  private async sendSettled(tenantId: string, turnId: string, hostId: string, sent: OfferSent | Error): Promise<void> {
    if (sent === "Sent") return;
    const host = await this.hostName(tenantId, hostId);
    const [reason, detail] = undelivered(host, sent);
    await this.failTurn(tenantId, turnId, reason, detail, iso(Date.now()));
  }

  private async armOffer(tenantId: string, session: SessionRow, turn: TurnRow): Promise<StoredTurnOffer | null> {
    const offer = await this.composeOffer(tenantId, session, turn);
    if (offer === null) return null;
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
    const prebuild = this.hostPrebuild(session.session_id);
    const offer: StoredTurnOffer = {
      type: "TurnOffer",
      turnId: turn.turn_id,
      sessionId: session.session_id,
      boxId: session.box_id,
      repository: session.repository,
      harness: HarnessSchema.parse(session.harness),
      harnessVersion: session.harness_version,
      model: session.model,
      prompt: prompt.prompt,
      boxMemoryMib: session.box_memory_mib,
      boxDiskMib: session.box_disk_mib,
      boxRetention: session.box_retention,
      turnSeconds: settingsOf(this.env).turnTotalBudgetSeconds,
      idleSeconds: BOX_IDLE_SECONDS,
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

  protected abstract hasUnsignaledRoomWait(): boolean;

  private hostHeadroom(hostId: string): HostHeadroom | undefined {
    return durableDb(this.ctx.storage, {}).get<HostHeadroom>(query`
      SELECT reported_health, memory_held_mib, memory_budget_mib, disk_held_mib, disk_budget_mib
      FROM host_reports WHERE host_id = ${hostId}`);
  }

  private headroomChanged(hostId: string, before: HostHeadroom, now: number): void {
    const after = this.hostHeadroom(hostId);
    if (after === undefined) throw new Error(`host ${hostId} has no committed report`);
    const code = roomFreed(before, after);
    if (code !== null) this.appendEvent({ event: "CapacityAvailable", hostId, code }, now);
  }

  private reportHost(hostId: string, report: HostReport): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO host_reports (host_id, box_capacity, channel_protocol, memory_budget_mib, memory_held_mib,
        memory_available_mib, disk_budget_mib, disk_held_mib, load_average, heard_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
      ON CONFLICT (host_id) DO UPDATE SET box_capacity = excluded.box_capacity,
        channel_protocol = excluded.channel_protocol, memory_budget_mib = excluded.memory_budget_mib,
        memory_held_mib = excluded.memory_held_mib, memory_available_mib = excluded.memory_available_mib,
        disk_budget_mib = excluded.disk_budget_mib, disk_held_mib = excluded.disk_held_mib,
        load_average = excluded.load_average, heard_at = excluded.heard_at
      WHERE host_reports.box_capacity != excluded.box_capacity
        OR host_reports.channel_protocol != excluded.channel_protocol
        OR host_reports.memory_budget_mib != excluded.memory_budget_mib
        OR host_reports.memory_held_mib != excluded.memory_held_mib
        OR host_reports.heard_at < excluded.heard_at - ?11`,
      hostId,
      report.boxCapacity,
      report.channelProtocol,
      report.usage.memoryBudgetMib ?? null,
      report.usage.memoryHeldMib ?? null,
      report.usage.memoryAvailableMib,
      report.usage.diskBudgetMib ?? null,
      report.usage.diskHeldMib ?? null,
      report.usage.loadAverage,
      report.now,
      HEARD_REFRESH_MS,
    );
  }

  private unheldTurns(hostId: string, heldTurnIds: string[]): UnheldTurnRow[] {
    return this.ctx.storage.sql
      .exec<UnheldTurnRow>(
        `SELECT turn_id, state, offer_sent, unheld_heartbeats FROM turns
        WHERE host_id = ? AND state IN ('Offered', 'Running')
          AND turn_id NOT IN (SELECT value FROM json_each(?))
          AND turn_id NOT IN (SELECT turn_id FROM snapshot_requests)`,
        hostId,
        JSON.stringify(heldTurnIds),
      )
      .toArray();
  }

  private unheldRunningTurns(hostId: string, heldTurnIds: string[]): string[] {
    return this.unheldTurns(hostId, heldTurnIds)
      .filter((turn) => turn.state === "Running")
      .map((turn) => turn.turn_id);
  }

  private judgeHeldTurns(hostId: string, heldTurnIds: string[]): string[] {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `UPDATE turns SET unheld_heartbeats = 0 WHERE turn_id IN (SELECT value FROM json_each(?))
        AND host_id = ? AND state IN ('Offered', 'Running') AND unheld_heartbeats = 1`,
      JSON.stringify(heldTurnIds),
      hostId,
    );
    const dropped: string[] = [];
    for (const turn of this.unheldTurns(hostId, heldTurnIds)) {
      if (turn.state === "Running" || turn.unheld_heartbeats === 1) dropped.push(turn.turn_id);
      else if (turn.offer_sent === 1)
        sql.exec("UPDATE turns SET unheld_heartbeats = 1 WHERE turn_id = ?", turn.turn_id);
    }
    return dropped;
  }

  private async dropTurns(tenantId: string, hostId: string, turnIds: string[], now: number): Promise<void> {
    if (turnIds.length === 0) return;
    const host = await this.hostName(tenantId, hostId);
    for (const turnId of turnIds)
      await this.failTurn(
        tenantId,
        turnId,
        "HostDropped",
        `host ${host} reported the turns it holds and this turn was not among them, so its work since the last snapshot is gone; send the turn again`,
        iso(now),
      );
  }

  protected async hostHello(
    tenantId: string,
    hostId: string,
    report: HostReport,
    heldTurnIds: string[],
  ): Promise<void> {
    const dropped = this.ctx.storage.transactionSync(() => {
      const [heard] = this.ctx.storage.sql
        .exec<{ heard_at: number }>("SELECT heard_at FROM host_reports WHERE host_id = ?", hostId)
        .toArray();
      const becamePresent = heard === undefined || heard.heard_at < report.now - presenceGraceMs(settingsOf(this.env));
      if (becamePresent) this.appendEvent({ event: "HostOnline", hostId }, report.now);
      const waiting = this.hasUnsignaledRoomWait();
      const before = waiting && !becamePresent ? this.hostHeadroom(hostId) : undefined;
      this.reportHost(hostId, report);
      if (before !== undefined) this.headroomChanged(hostId, before, report.now);
      if (waiting && becamePresent)
        this.appendEvent({ event: "CapacityAvailable", hostId, code: "NoHostAvailable" }, report.now);
      clearSupersededFailure(this.ctx.storage.sql, hostId);
      return this.unheldRunningTurns(hostId, heldTurnIds);
    });
    await this.dropTurns(tenantId, hostId, dropped, report.now);
  }

  protected async hostHeartbeat(
    tenantId: string,
    hostId: string,
    report: HostReport,
    reportedHealth: HostReportedHealth,
    held: { heldTurnIds: string[]; heldSessionIds: string[]; heldClaudeSetupIds: string[] },
  ): Promise<void> {
    const { heldTurnIds, heldSessionIds } = held;
    const dropped = this.ctx.storage.transactionSync(() => {
      const before = this.hasUnsignaledRoomWait() ? this.hostHeadroom(hostId) : undefined;
      this.ctx.storage.sql.exec(
        `UPDATE host_reports SET memory_budget_mib = ?2, memory_held_mib = ?3, memory_available_mib = ?4,
          disk_budget_mib = ?5, disk_held_mib = ?6, load_average = ?7, reported_health = ?8, heard_at = ?9
        WHERE host_id = ?1 AND (memory_budget_mib != ?2 OR memory_held_mib != ?3 OR reported_health != ?8 OR heard_at < ?9 - ?10)`,
        hostId,
        report.usage.memoryBudgetMib ?? null,
        report.usage.memoryHeldMib ?? null,
        report.usage.memoryAvailableMib,
        report.usage.diskBudgetMib ?? null,
        report.usage.diskHeldMib ?? null,
        report.usage.loadAverage,
        reportedHealth,
        report.now,
        HEARD_REFRESH_MS,
      );
      if (before !== undefined) this.headroomChanged(hostId, before, report.now);
      return this.judgeHeldTurns(hostId, [...heldTurnIds, ...this.dispatchingOffers]);
    });
    await this.dropTurns(tenantId, hostId, dropped, report.now);
    await this.reconcileHeldSessions(tenantId, hostId, heldSessionIds, report.now);
  }

  private async reconcileHeldSessions(
    tenantId: string,
    hostId: string,
    heldSessionIds: string[],
    now: number,
  ): Promise<void> {
    await this.releaseUnneededBoxes(tenantId, hostId, heldSessionIds, now);
    const held = JSON.stringify(heldSessionIds);
    const gone = this.ctx.storage.sql
      .exec<{ session_id: string }>(
        `UPDATE sessions SET state = 'Stopped', updated_at = ? WHERE host_id = ? AND state IN ('Idle', 'Stopping')
          AND session_id NOT IN (SELECT value FROM json_each(?))
          AND (state = 'Idle' OR NOT EXISTS (SELECT 1 FROM snapshot_requests r WHERE r.session_id = sessions.session_id))
        RETURNING session_id`,
        now,
        hostId,
        held,
      )
      .toArray();
    for (const { session_id } of gone) this.sessionEntered(session_id, "Stopped", now);
    for (const { session_id } of gone) await this.evictionSettled(tenantId, session_id);
    const requests = this.ctx.storage.sql
      .exec<SnapshotRequestRow>(
        `SELECT r.snapshot_id, r.session_id, r.box_id, r.turn_id, r.snapshot_seq, r.storage_key
        FROM snapshot_requests r CROSS JOIN sessions s ON s.session_id = r.session_id
        WHERE s.host_id = ? AND r.session_id NOT IN (SELECT value FROM json_each(?))`,
        hostId,
        held,
      )
      .toArray();
    if (requests.length > 0) {
      const host = await this.hostName(tenantId, hostId);
      const detail = `host ${host} reported the boxes it holds and the box of this snapshot was not among them, so the snapshot is gone`;
      await this.snapshotsGone(tenantId, requests, detail, "Idle", now);
    }
    await this.offerRoomed(tenantId, hostId, "Fail");
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
      await this.snapshotOrTeardown(tenantId, { ...session, state: "Stopping" }, latest);
    }
  }

  protected async forgetHostUsage(hostId: string, now: number): Promise<void> {
    const tenantId = this.ctx.id.name;
    if (tenantId === undefined) throw new Error(`the tenant Durable Object revoking host ${hostId} has no name`);
    this.ctx.storage.sql.exec("DELETE FROM host_reports WHERE host_id = ?", hostId);
    forgetSupervisorUpdates(this.ctx.storage.sql, hostId);
    const host = await this.hostName(tenantId, hostId);
    await this.failRevokedHostWork(tenantId, hostId, host, now);
  }

  protected runningTurnsByHost(): RunningTurns[] {
    return this.ctx.storage.sql
      .exec<{ host_id: string; running: number }>(
        `SELECT t.host_id, COUNT(DISTINCT t.session_id) AS running FROM turns t JOIN sessions s ON s.session_id = t.session_id
        WHERE t.state IN ('Offered', 'Running') AND s.state != 'Stopped' GROUP BY t.host_id`,
      )
      .toArray()
      .map((row) => ({ hostId: row.host_id, runningTurns: row.running }));
  }

  protected heldBoxes(sessionId: string | null = null): HeldBox[] {
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
            )) AS evictable,
          COALESCE((SELECT MAX(t.updated_at) FROM turns t WHERE t.session_id = s.session_id), s.updated_at) AS last_turn_ended_at
        FROM sessions s LEFT JOIN session_box_memory m ON m.session_id = s.session_id
          LEFT JOIN session_box_retention r ON r.session_id = s.session_id
        WHERE s.state IN ('Idle', 'Stopping') AND (?1 IS NULL OR s.session_id = ?1)`,
        sessionId,
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

  protected async hostRecords(tenantId: string): Promise<HostRecord[]> {
    return withReportedHealth(
      await listHosts(this.env, tenantId),
      this.listHostUsage(tenantId),
      Date.now() - presenceGraceMs(settingsOf(this.env)),
    );
  }

  protected listHostUsage(tenantId: string): ReportedHostUsage[] {
    return this.hostUsageWithout(tenantId, null);
  }

  private hostUsageWithout(tenantId: string, sessionId: string | null): ReportedHostUsage[] {
    return this.ctx.storage.sql
      .exec<HostReportRow>(
        `SELECT r.host_id, r.box_capacity, r.channel_protocol, r.memory_budget_mib, r.memory_held_mib,
          r.memory_available_mib, r.disk_budget_mib, r.disk_held_mib, r.load_average, r.reported_health, r.heard_at,
          r.created_at, COALESCE(b.running, 0) AS boxes_running, COALESCE(b.warm, 0) AS boxes_warm,
          COALESCE(b.memory_mib, 0) AS boxes_memory_mib, COALESCE(b.disk_mib, 0) AS boxes_disk_mib
        FROM host_reports r LEFT JOIN (
          SELECT s.host_id, SUM(s.state IN ('Starting', 'Running')) AS running,
            SUM(s.state IN ('Idle', 'Stopping')) AS warm,
            SUM(COALESCE(m.box_memory_mib, s.box_memory_mib)) AS memory_mib, SUM(s.box_disk_mib) AS disk_mib
          FROM sessions s LEFT JOIN session_box_memory m ON m.session_id = s.session_id
          WHERE s.state IN ('Starting', 'Running', 'Idle', 'Stopping') AND s.session_id IS NOT ?1 GROUP BY s.host_id
        ) b ON b.host_id = r.host_id
        ORDER BY r.created_at, r.host_id`,
        sessionId,
      )
      .toArray()
      .map((row) => ({
        hostId: row.host_id,
        tenantId,
        boxCapacity: row.box_capacity,
        boxesRunning: row.boxes_running,
        boxesWarm: row.boxes_warm,
        loadAverage: row.load_average,
        memoryAvailableMib: row.memory_available_mib,
        diskBudgetMib: row.disk_budget_mib,
        diskHeldMib: Math.max(row.disk_held_mib, row.boxes_disk_mib),
        memoryBudgetMib: row.memory_budget_mib,
        memoryHeldMib: Math.max(row.memory_held_mib, row.boxes_memory_mib),
        reportedHealth: row.reported_health,
        channelProtocol: row.channel_protocol,
        createdAt: row.created_at,
        updatedAt: row.heard_at,
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
        `host ${from} had not answered a snapshot when the session moved to host ${to}`,
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
    | { kind: "Released"; image: BootImage; host: HostEntry; release: ReleaseRead }
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
    const tags = this.startTags(input.startedBy, start.tags ?? []);
    if (tags.length > SESSION_TAG_LIMIT) return { kind: "TagsOverLimit", tagCount: tags.length };
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
      this.heldBoxes(),
      now - presenceGraceMs(settingsOf(this.env)),
    );
    const placement = placed;
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
        this.recordProgress(input.startedBy.sessionId);
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
      started: {
        session: this.presentSession(tenantId, session.session_id),
        turn: toTurn(tenantId, turn, null, NONE_STALE),
      },
    };
  }

  private recordProgress(sessionId: string): void {
    durableDb(this.ctx.storage, {}).run(query`UPDATE subscriptions SET start_refusals_in_a_row = 0
      WHERE session_id = ${sessionId} AND start_refusals_in_a_row > 0`);
  }

  private committed(claim: Claim | null, commit: () => TurnRow | SendRefusal): TurnRow | SendRefusal {
    return this.ctx.storage.transactionSync(() => claim?.() ?? commit());
  }

  private sendWaiting(
    tenantId: string,
    session: SessionRow,
    send: TurnSend,
    caller: TenantInput<"sendTurn">["caller"],
    now: number,
    claim: Claim | null,
  ): Sent {
    const turn = this.committed(claim, () => {
      if (caller.kind === "Turn") this.recordProgress(caller.sessionId);
      return this.newTurn(session.session_id, session.host_id, session.box_id, send, now);
    });
    if ("kind" in turn) return turn;
    return { kind: "Sent", turn: toTurn(tenantId, turn, null, NONE_STALE) };
  }

  protected async sendTurn(
    tenantId: string,
    sessionId: string,
    send: TurnSend,
    caller: TenantInput<"sendTurn">["caller"],
    hosts: HostRecord[],
    now: number,
    claim: Claim | null = null,
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
    if (this.inFlightTurns(sessionId).length > 0) return this.sendWaiting(tenantId, session, send, caller, now, claim);
    const online =
      !this.staleHosts(now).has(session.host_id) &&
      hosts.some((host) => host.hostId === session.host_id && host.state === "Online");
    if (online && session.state !== "Stopped") {
      const boxId = session.state === "Stopped" ? crypto.randomUUID() : session.box_id;
      const turn = this.runTurn(session, session.host_id, boxId, send, caller, now, claim);
      if ("kind" in turn) return turn;
      await this.offer(tenantId, { ...session, box_id: boxId }, turn);
      return { kind: "Sent", turn: toTurn(tenantId, turn, null, NONE_STALE) };
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
        this.heldBoxes(),
        now - presenceGraceMs(settingsOf(this.env)),
      );
    const stays = online ? place(hosts.filter((host) => host.hostId === session.host_id)) : null;
    const placement = stays?.kind === "Placed" && stays.evict.length === 0 ? stays : place(hosts);
    if (placement.kind === "Refused") return { kind: "Unplaced", hosts: placement.hosts };
    if (this.inFlightTurns(sessionId).length > 0) return this.sendWaiting(tenantId, session, send, caller, now, claim);
    const hostId = placement.host.hostId;
    const boxId = crypto.randomUUID();
    const turn = this.committed(claim, () => {
      this.settleSnapshotRequests(session, from, placement.host.name, iso(now));
      return this.runTurn(session, hostId, boxId, send, caller, now, null);
    });
    if ("kind" in turn) return turn;
    await this.offerAfter(tenantId, { ...session, host_id: hostId, box_id: boxId }, turn, placement.evict);
    if (session.state !== "Stopped") {
      await this.host(session.host_id).send({ type: "BoxDiscard", sessionId, boxId: session.box_id });
    }
    return { kind: "Sent", turn: toTurn(tenantId, turn, null, NONE_STALE) };
  }

  private async offerElsewhere(tenantId: string, session: SessionRow, turn: TurnRow): Promise<void> {
    const handoff = await this.placeElsewhere(tenantId, session, turn);
    if (handoff === null) return;
    await this.dispatchOffer(tenantId, turn.turn_id, handoff.hostId, handoff.offer);
  }

  private async placeElsewhere(tenantId: string, session: SessionRow, turn: TurnRow): Promise<Handoff | null> {
    const now = Date.now();
    const movable = this.unsnapshottedTurns(session.session_id).length === 0;
    const prebuild = this.hostPrebuild(session.session_id) !== null;
    const hosts = (await this.hostRecords(tenantId)).filter(
      (host) =>
        host.hostId !== session.host_id && movable && (!prebuild || host.architecture === PREBUILD_ARCHITECTURE),
    );
    const image = await this.imageAvailability(session.harness, session.harness_version, now);
    if (image.kind === "ReleaseUnreadable") {
      await this.failTurn(tenantId, turn.turn_id, "ImageNotReleased", image.detail, iso(now));
      return null;
    }
    const placement = placeSession(
      hosts,
      this.listHostUsage(tenantId),
      image.image,
      boxSizeOf(session),
      this.heldBoxes().filter((each) => each.sessionId !== session.session_id),
      now - presenceGraceMs(settingsOf(this.env)),
    );
    if (placement.kind === "Refused") {
      const healthy = !degradedOnly(placement.hosts);
      const detail = `no host of your tenant ${healthy ? "has room for" : "is healthy enough to take"} the turn: ${placement.hosts.map(why).join(", ")}`;
      await this.failTurn(tenantId, turn.turn_id, healthy ? "PoolExhausted" : "HostDegraded", detail, iso(now));
      return null;
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
    const moved = { ...session, host_id: hostId, box_id: boxId };
    if (placement.evict.length > 0) return this.evictFirst(tenantId, moved, turn, placement.evict);
    const offer = await this.armOffer(tenantId, moved, turn);
    if (offer === null) return null;
    return { hostId, offer };
  }

  private async evictFirst(tenantId: string, session: SessionRow, turn: TurnRow, victims: HeldBox[]): Promise<null> {
    await this.offerAfter(tenantId, session, turn, victims);
    return null;
  }

  private runTurn(
    session: SessionRow,
    hostId: string,
    boxId: string,
    send: TurnSend,
    caller: TenantInput<"sendTurn">["caller"],
    now: number,
    claim: Claim | null,
  ): TurnRow | SendRefusal {
    return this.committed(claim, () => {
      if (caller.kind === "Turn") this.recordProgress(caller.sessionId);
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
    if (session.harness !== "ClaudeCode") return { kind: "Unsupported" };
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
    personaFiles: PersonaFileDownload[],
    turnKey: CryptoKey,
    seconds: number,
    now: number,
  ): Promise<{ connector: DispatchConnector; personaFiles: PersonaFileDownload[] } | null> {
    if (session.harness !== "ClaudeCode") return null;
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
    if (session.state === "Stopping") {
      const latest = this.latestTurn(sessionId, null);
      if (latest === null) throw new Error(`session ${sessionId} has no turn, though a start always offers one`);
      const pending = this.ctx.storage.sql
        .exec<SnapshotRequestRow & { created_at: number }>(
          "SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, created_at FROM snapshot_requests WHERE session_id = ?",
          sessionId,
        )
        .toArray();
      const expired = pending.filter((request) => this.uploadSecondsLeft(request.created_at, now) < 1);
      for (const { created_at: _, ...request } of expired) {
        const detail = `the host had not answered snapshot ${request.snapshot_id} when its upload URLs expired, so stopping the session again gave it up`;
        this.recordSnapshotFailure(request, "NotAnswered", detail, iso(now));
      }
      await this.snapshotOrTeardown(tenantId, session, latest);
      return { kind: "Stopping", session: this.presentSession(tenantId, sessionId) };
    }
    if (session.state === "Stopped" || session.state === "Failed") {
      return { kind: "Stopping", session: this.presentSession(tenantId, sessionId) };
    }
    const running = this.inFlightTurns(sessionId)[0]?.turn_id ?? null;
    if (running !== null) {
      if (cancelledBy === null) return { kind: "InFlight", turnId: running };
      const turn = this.turnRow(running);
      if (turn === null) throw new Error(`turn ${running} is in flight but has no row`);
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
    const stopping = { ...session, state: "Stopping", updated_at: now };
    await this.snapshotOrTeardown(tenantId, stopping, latest);
    return { kind: "Stopping", session: this.presentSession(tenantId, sessionId) };
  }

  protected async archiveSession(tenantId: string, sessionId: string, now: number): Promise<Archive> {
    const session = this.sessionRow(sessionId);
    if (session === null) return { kind: "NotFound" };
    if (!["Idle", "Stopped", "Failed", "Archived"].includes(session.state)) {
      return { kind: "NotStopped", state: SessionStateSchema.parse(session.state) };
    }
    const sql = this.ctx.storage.sql;
    if (session.state !== "Archived") this.setSessionState(sessionId, "Archived", now);
    if (session.state === "Idle") {
      await this.host(session.host_id).send({ type: "BoxDiscard", sessionId, boxId: session.box_id });
    }
    const [restoring] = sql
      .exec(
        `SELECT 1 FROM prebuild_sessions JOIN session_prebuild_layers AS consumer USING (prebuild_id)
        JOIN sessions ON sessions.session_id = consumer.session_id
        WHERE prebuild_sessions.session_id = ?
          AND NOT EXISTS (SELECT 1 FROM snapshots WHERE snapshots.session_id = consumer.session_id)
          AND (sessions.state = 'Idle'
            OR EXISTS (SELECT 1 FROM snapshot_requests WHERE snapshot_requests.session_id = consumer.session_id)
            OR EXISTS (SELECT 1 FROM turns WHERE turns.session_id = consumer.session_id
              AND turns.state IN (SELECT value FROM json_each(?)))) LIMIT 1`,
        sessionId,
        JSON.stringify(IN_FLIGHT),
      )
      .toArray();
    if (restoring !== undefined) return { kind: "Archived", session: this.presentSession(tenantId, sessionId) };
    const unstored = sql
      .exec<{ storage_key: string }>(
        "SELECT storage_key FROM snapshot_requests WHERE session_id = ?1 UNION SELECT storage_key FROM snapshot_failures WHERE session_id = ?1 AND storage_key != ''",
        sessionId,
      )
      .toArray();
    const stored = this.storedSnapshots("WHERE session_id = ?", sessionId);
    await this.deleteObjects([...this.objectKeys(unstored), ...this.objectKeys(stored)]);
    this.ctx.storage.transactionSync(() => {
      this.releaseSnapshots(stored);
      sql.exec("DELETE FROM snapshot_failures WHERE session_id = ?", sessionId);
      sql.exec("DELETE FROM snapshot_requests WHERE session_id = ?", sessionId);
    });
    await this.cleanup.request(this.ctx.storage, now);
    return { kind: "Archived", session: this.presentSession(tenantId, sessionId) };
  }

  protected async deleteSession(tenantId: string, sessionId: string, now: number): Promise<SessionDeleted> {
    const archived = await this.archiveSession(tenantId, sessionId, now);
    if (archived.kind !== "Archived") return archived;
    const sql = this.ctx.storage.sql;
    const [held] = sql.exec("SELECT 1 FROM snapshots WHERE session_id = ? LIMIT 1", sessionId).toArray();
    if (held !== undefined) return { kind: "NotStopped", state: "Archived" };
    await deleteTranscript(this.env.STORE, transcriptPrefix(tenantId, sessionId));
    const db = durableDb(this.ctx.storage, tenantSchema);
    const triggerIds = db
      .select({ triggerId: tenantSchema.triggerSessionTargets.triggerId })
      .from(tenantSchema.triggerSessionTargets)
      .where(eq(tenantSchema.triggerSessionTargets.sessionId, sessionId))
      .all()
      .map((target) => target.triggerId);
    this.ctx.storage.transactionSync(() => {
      if (triggerIds.length > 0)
        db.delete(tenantSchema.triggers).where(inArray(tenantSchema.triggers.triggerId, triggerIds)).run();
      sql.exec("DELETE FROM sessions WHERE session_id = ?", sessionId);
    });
    return { kind: "Deleted", triggerIds };
  }

  private async collectSnapshots(tenantId: string, stored: SnapshotRequestRow, now: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const [open] = sql
      .exec("SELECT 1 FROM snapshot_requests WHERE session_id = ? LIMIT 1", stored.session_id)
      .toArray();
    if (open !== undefined) return this.archiveSupersededPrebuilds(tenantId, now);
    const failed = sql
      .exec<{ storage_key: string }>(
        "SELECT storage_key FROM snapshot_failures WHERE session_id = ? AND snapshot_seq < ? AND storage_key != ''",
        stored.session_id,
        stored.snapshot_seq,
      )
      .toArray();
    const older = this.storedSnapshots(
      "WHERE session_id = ? AND snapshot_seq < ?",
      stored.session_id,
      stored.snapshot_seq,
    );
    await this.deleteObjects([...this.objectKeys(older), ...this.objectKeys(failed)]);
    this.ctx.storage.transactionSync(() => this.releaseSnapshots(older));
    if (older.length + failed.length > 0) await this.cleanup.request(this.ctx.storage, now);
    await this.archiveSupersededPrebuilds(tenantId, now);
  }

  private releaseSnapshots(snapshots: { snapshot_id: string; storage_key: string }[]): void {
    for (const snapshot of snapshots) {
      this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE snapshot_id = ?", snapshot.snapshot_id);
    }
  }

  private objectKeys(snapshots: { storage_key: string }[]): string[] {
    return snapshots.flatMap((snapshot) => [
      snapshot.storage_key,
      packListKey(snapshot.storage_key),
      draftKey(snapshot.storage_key),
      indexKey(snapshot.storage_key),
    ]);
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
    const [held] = this.ctx.storage.sql
      .exec<{ snapshot_id: string }>(
        "SELECT snapshot_id FROM snapshots WHERE session_id = ? AND turn_id = ? LIMIT 1",
        session.session_id,
        latest.turn_id,
      )
      .toArray();
    if (held !== undefined) return this.teardown(session);
    return this.requestSnapshot(tenantId, session, latest);
  }

  private async teardown(session: SessionRow): Promise<void> {
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
    if (session.box_id !== message.boxId) return null;
    if (message.type === "BoxGone" && session.state === "Running") {
      await this.boxGoneUnderTurn(tenantId, hostId, session);
      await this.evictionSettled(tenantId, session.session_id);
      return null;
    }
    if (message.type === "BoxGone" && session.state === "Idle") {
      this.setSessionState(session.session_id, "Stopped", Date.now());
      await this.evictionSettled(tenantId, session.session_id);
      return null;
    }
    if (session.state !== "Stopping") return null;
    if (message.type === "BoxGone") {
      this.setSessionState(session.session_id, "Stopped", Date.now());
      await this.evictionSettled(tenantId, session.session_id);
      return null;
    }
    this.recordStopFailure(session.session_id, message.reason, message.detail, message.failedAt);
    await this.returnToIdle(tenantId, session.session_id);
    return null;
  }

  private async boxGoneUnderTurn(tenantId: string, hostId: string, session: SessionRow): Promise<void> {
    const sql = this.ctx.storage.sql;
    const requests = sql
      .exec<SnapshotRequestRow>(
        "SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key FROM snapshot_requests WHERE session_id = ? AND box_id = ?",
        session.session_id,
        session.box_id,
      )
      .toArray();
    const unasked = sql
      .exec<{ turn_id: string }>(
        `SELECT turn_id FROM turns WHERE session_id = ? AND box_id = ? AND state = 'Running'
          AND turn_id NOT IN (SELECT turn_id FROM snapshot_requests)`,
        session.session_id,
        session.box_id,
      )
      .toArray();
    if (requests.length === 0 && unasked.length === 0) return;
    const host = await this.hostName(tenantId, hostId);
    const detail = `host ${host} answered BoxGone for box ${session.box_id} while the session was Running, so the box and the work it held since the last snapshot are gone`;
    const now = Date.now();
    await this.snapshotsGone(tenantId, requests, detail, "Stopped", now);
    for (const { turn_id } of unasked)
      await this.failTurn(tenantId, turn_id, "BoxLost", `${detail}; send the turn again`, iso(now), "Stopped");
  }

  private async snapshotsGone(
    tenantId: string,
    requests: SnapshotRequestRow[],
    detail: string,
    sessionState: "Idle" | "Stopped",
    now: number,
  ): Promise<void> {
    for (const request of requests) {
      this.recordSnapshotFailure(request, "BoxNotFound", detail, iso(now));
      await this.snapshotNotStored(tenantId, request, detail, sessionState);
      const session = this.sessionRow(request.session_id);
      if (session === null) continue;
      if (session.state === "Stopping") await this.returnToIdle(tenantId, session.session_id);
      await this.prebuildUnstored(session, detail);
    }
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

  protected async readSession(tenantId: string, sessionId: string): Promise<Session | null> {
    return this.getSession(tenantId, sessionId, this.staleHosts(Date.now()));
  }

  private getSession(tenantId: string, sessionId: string, stale: StaleHosts = NONE_STALE): Session | null {
    const [row] = this.ctx.storage.sql
      .exec<SessionViewRow>(`${SESSION_VIEW_SELECT} WHERE s.session_id = ?`, sessionId)
      .toArray();
    return row === undefined
      ? null
      : toSession(tenantId, row, this.turnImage(row.last_turn_id), this.sessionLayer(row.session_id), stale);
  }

  protected async listSessions(tenantId: string, filter: SessionFilter): Promise<Session[] | null> {
    let keyset: [number, string] | [] = [];
    if (filter.after !== undefined) {
      const [after] = this.ctx.storage.sql
        .exec<{ created_at: number }>("SELECT created_at FROM sessions WHERE session_id = ?", filter.after)
        .toArray();
      if (after === undefined) return null;
      keyset = [after.created_at, filter.after];
    }
    const stale = this.staleHosts(Date.now());
    return this.ctx.storage.sql
      .exec<SessionViewRow>(
        `${SESSION_VIEW_SELECT} WHERE (?1 IS NULL OR s.state = ?1) AND (?2 IS NULL OR s.host_id = ?2)
        AND (?3 IS NULL OR t.updated_at <= ?3)
        AND NOT EXISTS (SELECT 1 FROM json_each(?4) AS wanted
          WHERE wanted.value NOT IN (SELECT tag FROM session_tags WHERE session_tags.session_id = s.session_id))
        AND NOT EXISTS (SELECT 1 FROM prebuild_sessions WHERE prebuild_sessions.session_id = s.session_id)
        AND (?5 IS NULL OR g.trigger_id = ?5)
        ${keyset.length === 0 ? "" : "AND (s.created_at, s.session_id) > (?7, ?8)"}
        ORDER BY s.created_at, s.session_id LIMIT ?6`,
        filter.state ?? null,
        filter.hostId ?? null,
        filter.lastTurnBefore ?? null,
        JSON.stringify(filter.tags ?? []),
        filter.triggerId ?? null,
        filter.limit ?? -1,
        ...keyset,
      )
      .toArray()
      .map((row) =>
        toSession(tenantId, row, this.turnImage(row.last_turn_id), this.sessionLayer(row.session_id), stale),
      );
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
    if (tags.length > SESSION_TAG_LIMIT) return { kind: "TagsOverLimit", tagCount: tags.length };
    return { kind: "Tagged", session: this.tagSession(tenantId, sessionId, tags, now) };
  }

  protected async listTurns(tenantId: string, sessionId: string): Promise<Turn[] | null> {
    if (this.sessionRow(sessionId) === null) return null;
    const rows = await Promise.all(
      this.turnRows(sessionId).map(async (row) => ({ ...row, line_count: await this.lineCount(tenantId, row) })),
    );
    const stale = this.staleHosts(Date.now());
    return rows.map((row) => toTurn(tenantId, row, this.turnImage(row.turn_id), stale));
  }

  private turnRows(sessionId: string): TurnRow[] {
    return this.ctx.storage.sql
      .exec<TurnRow>(`${TURN_SELECT} WHERE session_id = ? ORDER BY created_at, turn_id`, sessionId)
      .toArray();
  }

  protected async readTurn(tenantId: string, turnId: string): Promise<Turn | null> {
    const row = this.turnRow(turnId);
    if (row === null) return null;
    const read = { ...row, line_count: await this.lineCount(tenantId, row) };
    return toTurn(tenantId, read, this.turnImage(turnId), this.staleHosts(Date.now()));
  }

  private getTurn(tenantId: string, turnId: string, stale: StaleHosts = NONE_STALE): Turn | null {
    const row = this.turnRow(turnId);
    return row === null ? null : toTurn(tenantId, row, this.turnImage(turnId), stale);
  }

  private staleHosts(now: number): StaleHosts {
    const rows = this.ctx.storage.sql
      .exec<{ host_id: string; heard_at: number }>(
        "SELECT host_id, heard_at FROM host_reports WHERE heard_at < ?",
        now - presenceGraceMs(settingsOf(this.env)),
      )
      .toArray();
    return new Map(rows.map((row) => [row.host_id, row.heard_at]));
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

  protected async getTurnFailure(tenantId: string, turnId: string): Promise<TurnFailure | null> {
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
    const known = {
      sessionState: SessionStateSchema.parse(session.state),
      harness: HarnessSchema.parse(session.harness),
      lastLineSeq: tail?.last ?? ended,
      inFlight: read.some((turn) => IN_FLIGHT.includes(turn.state)),
    };
    const start = Math.max(after, before);
    const chunk =
      read.length === 0 || start >= known.lastLineSeq
        ? null
        : await firstChunkAfter(this.env.STORE, transcriptPrefix(tenantId, sessionId), start);
    if (chunk !== null && (turnId === null || chunk.turnId === turnId))
      return { ...known, kind: "Chunk", storageKey: chunk.storageKey, range: { offset: 0, length: chunk.size } };
    return { ...known, kind: "Lines" };
  }

  protected async prepareOffer(tenantId: string, turnId: string, hostId: string, now: number): Promise<PreparedOffer> {
    const turn = this.turnRow(turnId);
    const session = turn === null ? null : this.sessionRow(turn.session_id);
    if (turn === null || session === null || turn.state !== "Offered") return { kind: "Withdrawn" };
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
        ? await this.steerInbox(tenantId, session, turnId, files, turnKey, credentialSeconds, now)
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
    host: HostEntry,
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

  private async failRevokedHostWork(tenantId: string, hostId: string, host: string, now: number): Promise<void> {
    const turnDetail = `host ${host} was revoked during the turn; send the turn again on another host`;
    const snapshotDetail = `host ${host} was revoked before it answered the snapshot`;
    const running = this.ctx.storage.sql
      .exec<{ turn_id: string }>(
        "SELECT turn_id FROM turns WHERE host_id = ? AND state IN ('Offered', 'Running')",
        hostId,
      )
      .toArray();
    for (const { turn_id } of running) await this.failTurn(tenantId, turn_id, "HostRevoked", turnDetail, iso(now));
    const requests = this.ctx.storage.sql
      .exec<SnapshotRequestRow>(
        `SELECT r.snapshot_id, r.session_id, r.box_id, r.turn_id, r.snapshot_seq, r.storage_key
        FROM snapshot_requests r JOIN sessions s ON s.session_id = r.session_id WHERE s.host_id = ?`,
        hostId,
      )
      .toArray();
    for (const request of requests) {
      this.recordSnapshotFailure(request, "NotAnswered", snapshotDetail, iso(now));
      await this.snapshotNotStored(tenantId, request, snapshotDetail);
      const session = this.sessionRow(request.session_id);
      if (session === null) continue;
      if (session.state === "Stopping") await this.returnToIdle(tenantId, session.session_id);
      await this.prebuildUnstored(session, snapshotDetail);
    }
  }

  private async hostName(tenantId: string, hostId: string): Promise<string> {
    const host = await hostOf(this.env.DB, tenantId, hostId);
    if (host === null) throw new Error(`host ${hostId} runs a session of tenant ${tenantId}, which does not list it`);
    return host.name;
  }

  protected async hostMessage(
    tenantId: string,
    hostId: string,
    message: SessionHostMessage,
  ): Promise<HostReply | null> {
    if (message.type === "SnapshotChunks") return this.snapshotChunks(tenantId, hostId, message);
    if (message.type === "SnapshotChunkCheck") return this.snapshotChunkCheck(tenantId, hostId, message);
    if (message.type === "SnapshotIndexAsk") return this.snapshotIndexAsk(tenantId, hostId, message);
    if (message.type === "SnapshotPacks") return this.snapshotPacks(tenantId, hostId, message);
    if (message.type === "RestoreChunks") return this.restoreChunks(tenantId, message);
    if ((message.type === "TurnComplete" || message.type === "TurnFailed") && message.credentialFile !== undefined) {
      const offered = this.offeredTurn(hostId, message);
      if (offered.type === "Refused") return offered;
      await this.storeCredentialFile(offered.session, message.credentialFile);
    }
    if (message.type === "TurnRepositoryCloneFailed") return this.cloneFailed(tenantId, hostId, message);
    if (message.type === "TurnFailed") return this.turnFailed(tenantId, hostId, message);
    if (message.type === "TurnClaim") return this.turnClaim(hostId, message);
    if (message.type === "SnapshotDone" || message.type === "SnapshotFailed") {
      return this.snapshotAnswer(tenantId, hostId, message);
    }
    if (message.type === "BoxGone" || message.type === "BoxTeardownFailed") {
      return this.teardownAnswer(tenantId, hostId, message);
    }
    const offered = this.offeredTurn(hostId, message);
    if (offered.type === "Refused") return offered;
    await this.turnEvent(tenantId, offered, message);
    return null;
  }

  private snapshotUploadWindow(
    tenantId: string,
    hostId: string,
    snapshotId: string,
  ): { request: SnapshotRequestRow; now: number; expiresAt: number; seconds: number } | Refused {
    const [request] = this.ctx.storage.sql
      .exec<SnapshotRequestRow & { created_at: number }>(
        "SELECT snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, created_at FROM snapshot_requests WHERE snapshot_id = ?",
        snapshotId,
      )
      .toArray();
    if (request === undefined) return refused(`snapshot ${snapshotId} has no pending upload request`);
    if (this.sessionRow(request.session_id)?.host_id !== hostId) {
      return refused(
        `host ${hostId} sent chunks of snapshot ${snapshotId} of tenant ${tenantId}, which it was not asked for`,
      );
    }
    const now = Date.now();
    const seconds = this.uploadSecondsLeft(request.created_at, now);
    if (seconds < 1) return refused(`the upload window for snapshot ${snapshotId} has expired`);
    return { request, now, expiresAt: this.uploadExpiresAt(request.created_at), seconds };
  }

  private uploadExpiresAt(createdAt: number): number {
    return createdAt + settingsOf(this.env).snapshotDeadlineSeconds * 1000;
  }

  private uploadSecondsLeft(createdAt: number, now: number): number {
    return Math.floor((this.uploadExpiresAt(createdAt) - now) / 1000);
  }

  private snapshotChunks(
    tenantId: string,
    hostId: string,
    message: Extract<ChunkAsk, { type: "SnapshotChunks" }>,
  ): ChunkReply | Refused {
    const window = this.snapshotUploadWindow(tenantId, hostId, message.snapshotId);
    if ("type" in window) return window;
    return { type: "SnapshotChunksHeld", snapshotId: message.snapshotId, part: message.part, held: [] };
  }

  private previousSnapshot(sessionId: string): { storage_key: string } | undefined {
    const [previous] = this.ctx.storage.sql
      .exec<{ storage_key: string }>(
        `SELECT storage_key FROM (
          SELECT 0 AS source, snapshot_seq, storage_key FROM snapshots WHERE session_id = ?1
          UNION ALL SELECT 1, snapshots.snapshot_seq, snapshots.storage_key FROM session_prebuild_layers
          JOIN prebuild_sessions USING (prebuild_id) JOIN snapshots ON snapshots.session_id = prebuild_sessions.session_id
          WHERE session_prebuild_layers.session_id = ?1
        ) ORDER BY source, snapshot_seq DESC LIMIT 1`,
        sessionId,
      )
      .toArray();
    return previous;
  }

  private async snapshotChunkCheck(
    tenantId: string,
    hostId: string,
    message: Extract<ChunkAsk, { type: "SnapshotChunkCheck" }>,
  ): Promise<ChunkReply | Refused> {
    const window = this.snapshotUploadWindow(tenantId, hostId, message.snapshotId);
    if ("type" in window) return window;
    const previous = this.previousSnapshot(window.request.session_id);
    if (previous === undefined) {
      return { type: "SnapshotChunkCheckHeld", snapshotId: message.snapshotId, check: message.check, held: [] };
    }
    const held = await heldPlacements(this.env.STORE, previous.storage_key, message.digests);
    if (held.kind !== "Read") {
      return refused(`host ${hostId} checked chunks of snapshot ${message.snapshotId}, but ${held.detail}`);
    }
    return { type: "SnapshotChunkCheckHeld", snapshotId: message.snapshotId, check: message.check, held: held.value };
  }

  private async snapshotIndexAsk(
    tenantId: string,
    hostId: string,
    message: Extract<ChunkAsk, { type: "SnapshotIndexAsk" }>,
  ): Promise<ChunkReply | Refused> {
    if (message.sizeBytes > MAX_INDEX_BYTES) {
      return refused(
        `host ${hostId} asked to upload a ${message.sizeBytes}-byte index of snapshot ${message.snapshotId}, above the ${MAX_INDEX_BYTES} of the largest snapshot's index`,
      );
    }
    const window = this.snapshotUploadWindow(tenantId, hostId, message.snapshotId);
    if ("type" in window) return window;
    const url = await signerOf(
      this.env,
      this.env.R2_BUCKET_NAME,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    ).presignChecked(
      indexKey(window.request.storage_key),
      message.digest,
      message.sizeBytes,
      window.seconds,
      new Date(window.now),
    );
    return {
      type: "SnapshotIndexUpload",
      snapshotId: message.snapshotId,
      url,
      uploadExpiresAt: iso(window.expiresAt),
    };
  }

  private async snapshotPacks(
    tenantId: string,
    hostId: string,
    message: Extract<ChunkAsk, { type: "SnapshotPacks" }>,
  ): Promise<ChunkReply | Refused> {
    const window = this.snapshotUploadWindow(tenantId, hostId, message.snapshotId);
    if ("type" in window) return window;
    const listed = new Set(message.packs.map((pack) => pack.packDigest));
    const unlisted = message.chunks.find((chunk) => !listed.has(chunk.packDigest));
    if (unlisted !== undefined) {
      return refused(
        `host ${hostId} placed chunk ${unlisted.digest} of snapshot ${message.snapshotId} in pack ${unlisted.packDigest}, which part ${message.part} does not list`,
      );
    }
    const twice = message.reusedPackDigests.find((packDigest) => listed.has(packDigest));
    if (twice !== undefined) {
      return refused(
        `host ${hostId} listed pack ${twice} of snapshot ${message.snapshotId} in part ${message.part} as both written and reused`,
      );
    }
    const merged = mergedDraft(
      await snapshotDraft(this.env.STORE, window.request.storage_key),
      message.part,
      [...listed],
      message.reusedPackDigests,
    );
    if (merged.kind === "Refused") {
      return refused(
        `host ${hostId} sent SnapshotPacks part ${message.part} of snapshot ${message.snapshotId}, ${merged.detail}`,
      );
    }
    await this.env.STORE.put(draftKey(window.request.storage_key), JSON.stringify(merged.draft));
    const signer = signerOf(
      this.env,
      this.env.R2_BUCKET_NAME,
      this.env.R2_ACCESS_KEY_ID,
      this.env.R2_SECRET_ACCESS_KEY,
    );
    const uploads = [];
    for (const pack of message.packs) {
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
    message: Extract<ChunkAsk, { type: "RestoreChunks" }>,
  ): Promise<ChunkReply | Refused> {
    const now = Date.now();
    const seconds = turnCredentialSeconds(settingsOf(this.env));
    const held = [...new Set(message.chunks.map((chunk) => chunk.packDigest))].sort();
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
      downloadExpiresAt: iso(now + seconds * 1000),
    };
  }

  private async cloneFailed(tenantId: string, hostId: string, message: CloneFailed): Promise<HostReply | null> {
    const offered = this.offeredTurn(hostId, message);
    if (offered.type === "Refused") return offered;
    const { turn, session } = offered;
    const discard: HostReply = { type: "BoxDiscard", sessionId: session.session_id, boxId: turn.box_id };
    if (turn.state === "Failed" && turn.reason === "RepositoryCloneFailed") return discard;
    if (!IN_FLIGHT.includes(turn.state)) return null;
    const detail = this.cloneFailureDetail(session, message.detail);
    await this.failTurn(tenantId, turn.turn_id, "RepositoryCloneFailed", detail, message.failedAt, "Failed");
    return discard;
  }

  private async turnFailed(tenantId: string, hostId: string, message: TurnFailed): Promise<HostReply | null> {
    const offered = this.offeredTurn(hostId, message);
    if (offered.type === "Refused") return offered;
    const { turn, session } = offered;
    const now = Date.now();
    if (message.reason === "HostUpdating" && turn.state === "Offered") {
      await this.offerElsewhere(tenantId, session, turn);
      return null;
    }
    const handedOver =
      message.reason === "HostUpdating" && turn.state === "Running" && (await this.lineCount(tenantId, turn)) === 0;
    if (handedOver || (message.reason === "NotClaimed" && IN_FLIGHT.includes(turn.state))) {
      this.ctx.storage.sql.exec(
        "UPDATE turns SET state = 'Offered', offer_sent = 1, unheld_heartbeats = 0, updated_at = ? WHERE turn_id = ?",
        now,
        turn.turn_id,
      );
      const offeredAgain = { ...turn, state: "Offered" as const };
      if (!handedOver) return this.composeOffer(tenantId, session, offeredAgain);
      await this.offerElsewhere(tenantId, session, offeredAgain);
      return null;
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

  private async turnClaim(hostId: string, message: TurnClaim): Promise<HostReply> {
    const elsewhere = this.turnRow(message.turnId);
    if (elsewhere !== null && elsewhere.host_id !== hostId) return { type: "TurnWithdrawn", turnId: elsewhere.turn_id };
    const offered = this.offeredTurn(hostId, message);
    if (offered.type === "Refused") return offered;
    const { turn, session } = offered;
    if (turn.state === "Running" && turn.box_id === message.boxId) return { type: "TurnClaimed", turnId: turn.turn_id };
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
    return { type: "TurnClaimed", turnId: turn.turn_id };
  }

  private async turnEvent(tenantId: string, { turn, session }: OfferedTurn, message: TurnEvent): Promise<void> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    if (message.type === "TurnImageFetching" || message.type === "TurnRepositoryReady") return;
    if (turn.state !== "Running") return;
    if (message.type === "TurnLines")
      return this.appendLines(tenantId, session, turn, message.firstLineSeq, message.lines, now);
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
    if (message.warning !== undefined)
      sql.exec(
        "INSERT INTO turn_warnings (turn_id, warning, created_at) VALUES (?, ?, ?)",
        turn.turn_id,
        message.warning,
        now,
      );
    await this.requestSnapshot(tenantId, session, turn);
  }

  private snapshotAsked(turnId: string): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ snapshot_id: string }>("SELECT snapshot_id FROM snapshot_requests WHERE turn_id = ? LIMIT 1", turnId)
      .toArray();
    return row !== undefined;
  }

  private async snapshotNotStored(
    tenantId: string,
    request: SnapshotRequestRow,
    detail: string,
    sessionState: "Idle" | "Stopped" = "Idle",
  ): Promise<void> {
    await this.failTurn(
      tenantId,
      request.turn_id,
      "SnapshotNotStored",
      `${detail}; send the turn again`,
      iso(Date.now()),
      sessionState,
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
    const ended = await this.endedTranscript(tenantId, turn);
    const next = this.ctx.storage.transactionSync(() => {
      record(ended);
      releaseConnectorCredentials(this.ctx.storage.sql);
      return this.takeNextWaiting(turn.session_id, now);
    });
    this.runningTails.delete(turn.turn_id);
    const session = this.sessionRow(turn.session_id);
    const release = session?.state === "Idle" && session.box_retention === "Off";
    if (release) this.setSessionState(session.session_id, "Stopping", now);
    if (next !== null) return this.startWaiting(tenantId, turn.session_id, next);
    const settled = this.sessionRow(turn.session_id);
    if (settled?.state !== "Idle" && settled?.state !== "Stopping") return;
    await this.requestSnapshot(tenantId, settled, turn);
  }

  private async appendLines(
    tenantId: string,
    session: SessionRow,
    turn: TurnRow,
    firstLineSeq: number,
    texts: string[],
    now: number,
  ): Promise<void> {
    const last = await this.lastLineSeq(tenantId, session, turn);
    const lastLineSeq = firstLineSeq + texts.length - 1;
    if (lastLineSeq <= last) return;
    if (firstLineSeq > last + 1) {
      return this.failTurn(
        tenantId,
        turn.turn_id,
        "TranscriptGap",
        `the turn sent lines from lineSeq ${firstLineSeq}, but the control plane holds lines up to ${last}; the lines in between were lost on the channel, so send the turn again`,
        iso(now),
      );
    }
    const fresh = texts.slice(last + 1 - firstLineSeq);
    const lines = fresh.map((text, at) =>
      toLine(tenantId, {
        session_id: session.session_id,
        line_seq: last + 1 + at,
        turn_id: turn.turn_id,
        text,
        created_at: now,
      }),
    );
    const succeeded = successResultOf(HarnessSchema.parse(session.harness));
    if (succeeded !== null && fresh.some((text) => succeeded(parseJson(text)) === true))
      this.ctx.storage.sql.exec(
        "UPDATE turns SET result_printed = 1 WHERE turn_id = ? AND result_printed = 0",
        turn.turn_id,
      );
    const storageKey = chunkKey(tenantId, session.session_id, turn.turn_id, last + 1, lastLineSeq);
    const refused = await this.env.STORE.put(storageKey, encodeChunk(lines).body).then(
      () => null,
      (error: unknown) => errorOf(error).message,
    );
    if (refused !== null) {
      console.error(`TranscriptNotStored: the transcript store refused lines of turn ${turn.turn_id}: ${refused}`);
      return this.failTurn(
        tenantId,
        turn.turn_id,
        "TranscriptGap",
        `TranscriptNotStored: the transcript store refused the lines of this turn, so the control plane dropped them; send the turn again: ${refused}`,
        iso(now),
      );
    }
    this.rememberTail(
      turn.turn_id,
      this.runningTail(tenantId, turn).then((tail) => withChunk(tail, last + 1, lastLineSeq)),
    );
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
    if (this.sessionRow(turn.session_id)?.host_id !== turn.host_id)
      return this.recordTurnFailure(turn.session_id, turnId, reason, detail, failedAt, turn.line_count, Date.now());
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
    await this.failPrebuild(prebuild.prebuild_id, ["Dispatched", "Building"], report, prebuild.log_url, now);
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

  private async snapshotChecked(
    tenantId: string,
    hostId: string,
    request: SnapshotRequestRow,
  ): Promise<{ kind: "Rejected"; detail: string } | { kind: "Checked"; packs: string[]; reused: ReadonlySet<string> }> {
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
    const draft = await snapshotDraft(this.env.STORE, request.storage_key);
    if (draft === null) {
      return rejected(
        `answered SnapshotDone for snapshot ${request.snapshot_id} without sending SnapshotPacks part 1, so the control plane cannot name its packs and the session keeps its previous snapshot; update the supervisor`,
      );
    }
    const packs = new Set(draft.packs);
    const unnamed = parsed.data.manifest.find((placement) => !packs.has(placement.packDigest));
    if (unnamed !== undefined) {
      return rejected(
        `stored snapshot ${request.snapshot_id} whose root places its manifest in pack ${unnamed.packDigest}, which no SnapshotPacks part named, so the control plane cannot keep it and the session keeps its previous snapshot; update the supervisor`,
      );
    }
    return { kind: "Checked", packs: [...packs].sort(), reused: new Set(draft.reused) };
  }

  private async unheldPack(
    tenantId: string,
    previous: { storage_key: string } | undefined,
    packs: string[],
    reused: ReadonlySet<string>,
  ): Promise<string | undefined> {
    const listed = previous === undefined ? null : await packList(this.env.STORE, previous.storage_key);
    const named = listed?.kind === "Read" ? listed.value : new Set<string>();
    const unproven = packs.filter((packDigest) => !reused.has(packDigest) || !named.has(packDigest));
    const found = await Promise.all(unproven.map((packDigest) => this.env.STORE.head(packKey(tenantId, packDigest))));
    return unproven.find((_, at) => found[at] === null);
  }

  private async snapshotOutcome(
    tenantId: string,
    hostId: string,
    request: SnapshotRequestRow,
    message: Extract<HostMessage, { type: "SnapshotDone" }>,
  ): Promise<
    | { kind: "Rejected"; detail: string }
    | { kind: "Answered" }
    | { kind: "Stored"; now: number; completes: boolean; next: string | null }
  > {
    const storageFailed = (error: unknown): string =>
      `object storage failed while the control plane checked snapshot ${request.snapshot_id}, so the session keeps its previous snapshot: ${errorOf(error).message}`;
    const checked = await this.snapshotChecked(tenantId, hostId, request).catch(
      (error: unknown): { kind: "Rejected"; detail: string } => ({
        kind: "Rejected",
        detail: storageFailed(error),
      }),
    );
    if (checked.kind === "Rejected") return checked;
    const turn = this.turnRow(request.turn_id);
    const ended = turn === null ? null : await this.endedTranscript(tenantId, turn);
    return this.ctx.blockConcurrencyWhile(async () => {
      const sorted = checked.packs;
      const previous = this.previousSnapshot(request.session_id);
      const missing = await this.unheldPack(tenantId, previous, sorted, checked.reused).catch((error: unknown) => ({
        failed: storageFailed(error),
      }));
      if (typeof missing === "object") return { kind: "Rejected", detail: missing.failed };
      if (missing !== undefined) {
        return {
          kind: "Rejected",
          detail: `snapshot ${request.snapshot_id} names pack ${missing}, which object storage does not hold, so the session keeps its previous snapshot`,
        };
      }
      const [stillPending] = this.ctx.storage.sql
        .exec("SELECT 1 FROM snapshot_requests WHERE snapshot_id = ?", request.snapshot_id)
        .toArray();
      if (stillPending === undefined) return { kind: "Answered" };
      await this.env.STORE.put(packListKey(request.storage_key), JSON.stringify(sorted));
      await this.env.STORE.delete(draftKey(request.storage_key));
      return { kind: "Stored", ...this.storeSnapshot(request, message.uploadedBytes, ended) };
    });
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
      this.recordSnapshotFailure(request, message.reason, message.detail, message.failedAt);
      const detail = `snapshot ${request.snapshot_id} failed ${message.reason}: ${message.detail}`;
      await this.prebuildUnstored(session, detail);
      const boxless = session.state === "Stopping" && message.reason === "BoxNotFound";
      await this.snapshotNotStored(tenantId, request, detail, boxless ? "Stopped" : "Idle");
      if (boxless) {
        if (this.sessionRow(session.session_id)?.state === "Stopping")
          this.setSessionState(session.session_id, "Stopped", Date.now());
        await this.evictionSettled(tenantId, session.session_id);
      }
      if (session.state === "Stopping" && message.reason !== "BoxNotFound")
        await this.returnToIdle(tenantId, session.session_id);
      return null;
    }
    const outcome = await this.snapshotOutcome(tenantId, hostId, request, message);
    if (outcome.kind === "Answered") return null;
    if (outcome.kind === "Rejected") {
      this.recordSnapshotFailure(request, "UploadRejected", outcome.detail, iso(Date.now()));
      await this.prebuildUnstored(session, outcome.detail);
      await this.snapshotNotStored(tenantId, request, outcome.detail);
      if (session.state === "Stopping") await this.returnToIdle(tenantId, session.session_id);
      return null;
    }
    const { now, completes, next } = outcome;
    await this.prebuildStored(tenantId, request, message.uploadedBytes, now);
    const completed = this.sessionRow(session.session_id);
    if (completes && completed?.state === "Idle" && completed.box_retention === "Off")
      this.setSessionState(completed.session_id, "Stopping", now);
    if (next !== null) await this.startWaiting(tenantId, request.session_id, next);
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
      releaseConnectorCredentials(sql);
      return this.takeNextWaiting(request.session_id, now);
    });
    if (completes) this.runningTails.delete(request.turn_id);
    return { now, completes, next };
  }
}
