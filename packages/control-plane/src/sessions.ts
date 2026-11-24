import { type CredentialRefusal, checkModelCredential, credentialProblem } from "@tumpel/api/credentials";
import {
  SessionListQuerySchema,
  SessionPathSchema,
  SessionStartFromIssueSchema,
  SessionStartSchema,
  SessionStopQuerySchema,
  SessionTagsPatchSchema,
  SessionTagsSchema,
  StartRefusalCodeSchema,
  StartRefusalSchema,
  SteerCreateSchema,
  type SteerSchema,
  TranscriptPageSchema,
  TranscriptQuerySchema,
  TurnPathSchema,
  TurnSendSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { boundedTo } from "./bounded-detail.ts";
import { compactorOf } from "./compact.ts";
import { DISCONNECTED_FIX, disconnectedDetail } from "./connector-rows.ts";
import { deployInProgress } from "./deploy-drain.ts";
import { githubRepository, notARepository, readIssue, repositoryUrl } from "./github.ts";
import {
  GOAL_FOLDS,
  GOAL_TURN_CAP,
  HARNESS_CATALOG,
  type HarnessCatalogEntry,
  pinnedEntry,
} from "./harness-catalog.ts";
import { type HostRecord, hostOf, listHostRecords, type Outcome, type Refused } from "./hosts.ts";
import { issues, json, noContent, parseBody, problem, refuse } from "./http.ts";
import { type Caller, whoamiOf } from "./identity.ts";
import type { Env } from "./index.ts";
import type { StoredPersona } from "./persona-files.ts";
import { type placementRefusals, stranded, unplaced } from "./placement.ts";
import { releaseUnreadable } from "./releases.ts";
import { unreadableSecretSet } from "./secret-members.ts";
import { settingsOf } from "./settings.ts";
import type { SecretSetRead } from "./tenant.ts";
import { tenantApi } from "./tenant-api.ts";
import {
  type CredentialHandover,
  type NewSession,
  SESSION_TAG_LIMIT,
  type Session,
  type SessionFilter,
  type SessionStart,
  type SessionStarted,
  type Snapshot,
  type StartedSession,
  type StartedSessionFromIssue,
  type StopFailure,
  type TranscriptCursor,
  type Turn,
  type TurnFailure,
  type TurnSend,
} from "./tenant-sessions.ts";
import { ticketBranch, ticketPrompt } from "./ticket-prompt.ts";
import {
  chunksFrom,
  chunksWithin,
  DEFAULT_PAGE_BYTES,
  decodeLines,
  emptyPage,
  type Page,
  pageOf,
  type Range,
  type StoredChunk,
  type TranscriptLine,
  transcriptPrefix,
} from "./transcript.ts";

export type TranscriptPage = z.infer<typeof TranscriptPageSchema>;
export type TranscriptQuery = z.infer<typeof TranscriptQuerySchema>;
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;
type Steer = z.infer<typeof SteerSchema>;
type SessionStopQuery = z.infer<typeof SessionStopQuerySchema>;
export type SessionStartFromIssue = z.infer<typeof SessionStartFromIssueSchema>;

export interface CompactTranscriptLine {
  lineSeq: number;
  text: string;
  createdAt: number;
  durationMs: number;
}

export interface CompactTranscriptTurn {
  turnId: string;
  lines: CompactTranscriptLine[];
  startedAt: number;
  endedAt: number;
}

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });

const sessionNotFound = (sessionId: string): Refused =>
  refuse(404, {
    code: "NotFound",
    title: "No such session",
    detail: `your tenant has no session ${sessionId}`,
    fix: "List your sessions and use one of their ids",
  });

const sessionArchived = (sessionId: string, refused: string): Refused =>
  refuse(409, {
    code: "SessionArchived",
    title: "Session archived",
    detail: `session ${sessionId} is archived and takes no ${refused}`,
    fix: "Start a new session; the archived session's transcript stays readable",
  });

const hostOffline = async (env: Env, caller: Caller, session: Session, retry: string): Promise<Refused | null> => {
  const host = await hostOf(env.DB, caller.tenantId, session.hostId);
  if (host !== null && host.state !== "Revoked" && session.state !== "Unknown") return null;
  return refuse(409, {
    code: "HostOffline",
    title: "Host offline",
    detail:
      host === null
        ? "the session's host is no longer enrolled"
        : host.state === "Revoked"
          ? `the session runs on host ${host.name}, which is Revoked`
          : `the session runs on host ${host.name}, which has not reported to the control plane within its heartbeat grace`,
    fix: `Start tumpel-supervisor run on that host, then ${retry}`,
  });
};

const turnNotFound = (turnId: string): Refused =>
  refuse(404, {
    code: "NotFound",
    title: "No such turn",
    detail: `your tenant has no turn ${turnId}`,
    fix: "List the session's turns and use one of their ids",
  });

export const credentialRefused = (refusal: CredentialRefusal, owner: string, harness: string, retry: string): Refused =>
  refuse(422, credentialProblem(refusal, owner, harness, retry));

const tenantOf = (env: Env, caller: Caller) => tenantApi(env.TENANT, caller.tenantId);

const personaNotFound = (personaId: string): Refused =>
  refuse(404, {
    code: "NotFound",
    title: "No such persona",
    detail: `your tenant owns no persona ${personaId}`,
    fix: "List your personas and start with one of their ids",
  });

export interface StartCheck {
  personaId: string;
  persona: StoredPersona | null;
  pins: readonly { harness: string; harnessVersion: string }[];
  secretSet: (persona: StoredPersona) => SecretSetRead;
  model: string;
  operation: string;
  now: number;
}

export const checkStart = (check: StartCheck): Outcome<HarnessCatalogEntry> => {
  const { persona } = check;
  if (persona === null) return personaNotFound(check.personaId);
  const entry = pinnedEntry(check.pins, persona.harness);
  if (entry === undefined) {
    return refuse(422, {
      code: "HarnessNotInCatalog",
      title: "Harness not in the catalog",
      detail: `persona ${persona.name} runs ${persona.harness}, of which the catalog has no version your tenant can run; it holds ${HARNESS_CATALOG.map((listed) => `${listed.harness} ${listed.harnessVersion}`).join(", ")}`,
      fix: "Pin a listed version of that harness, or point the persona at a harness the catalog lists",
    });
  }
  const read = check.secretSet(persona);
  if (read.kind === "NotFound") {
    throw new Error(`persona ${persona.personaId} names secret set ${persona.secretSetId}, which does not exist`);
  }
  if (read.kind === "Unreadable") return refuse(409, unreadableSecretSet(check.operation, read));
  const { secretSet } = read;
  const credential = checkModelCredential(entry, secretSet.keys, check.model, check.now);
  if (credential.kind !== "Usable") {
    return credentialRefused(
      credential,
      `secret set ${secretSet.name} of persona ${persona.name}`,
      persona.harness,
      "start again",
    );
  }
  return ok(entry);
};

export const startable = async (
  env: Env,
  tenantId: string,
  personaId: string,
  model: string,
  operation: string,
  now: number,
): Promise<Outcome<HarnessCatalogEntry>> => {
  const tenant = tenantApi(env.TENANT, tenantId);
  const { persona } = await tenant.call("getPersona", { tenantId, personaId });
  if (persona === null) return personaNotFound(personaId);
  const { pins } = await tenant.call("listPins", {});
  const { read } = await tenant.call("getSecretSet", { tenantId, secretSetId: persona.secretSetId });
  return checkStart({ personaId, persona, pins, secretSet: () => read, model, operation, now });
};

export const startTarget = (repository: string): Outcome<string> => {
  const target = githubRepository(repository);
  return target === null ? refuse(422, notARepository(repository)) : ok(repositoryUrl(target));
};

const prepareStart = async (
  env: Env,
  caller: Caller,
  start: SessionStart,
  endpoint: string,
  now: number,
): Promise<Outcome<NewSession>> => {
  const repository = startTarget(start.repository);
  if (!repository.ok) return repository;
  const checked = await startable(env, caller.tenantId, start.personaId, start.model, "sessions.start", now);
  if (!checked.ok) {
    const { code, detail } = checked.problem;
    const reason = StartRefusalCodeSchema.safeParse(code);
    if (!reason.success) return checked;
    const recorded = await tenantOf(env, caller).call("recordStartRefusal", {
      tenantId: caller.tenantId,
      refusal: { code: reason.data, detail: boundedTo(StartRefusalSchema.shape.detail.maxLength, detail) },
      personaId: start.personaId,
      model: start.model,
      caller: caller.origin,
      requestedTags: start.tags ?? [],
      now,
    });
    return recorded.kind === "TagsOverLimit" ? placed<never>(recorded) : checked;
  }
  const entry = checked.value;
  return ok({
    principalId: caller.principalId,
    startedBy: caller.origin,
    hosts: await listHostRecords(env, caller.tenantId),
    harness: entry.harness,
    harnessVersion: entry.harnessVersion,
    endpoint,
    start: { ...start, repository: repository.value },
  });
};

const connectorDisconnected = (names: string[]): Refused =>
  refuse(409, {
    code: "ConnectorDisconnected",
    title: "Connector not connected",
    detail: disconnectedDetail(names),
    fix: DISCONNECTED_FIX,
  });

export const placed = <T>(
  started:
    | Exclude<SessionStarted<T>, { kind: "Unplaced" }>
    | { kind: "Unplaced"; hosts: Parameters<typeof placementRefusals>[0] },
): Outcome<T> => {
  if (started.kind === "Unplaced") return unplaced(started.hosts, "start again");
  if (started.kind === "ConnectorDisconnected") return connectorDisconnected(started.names);
  if (started.kind === "TagsOverLimit") {
    return refuse(422, {
      code: "InvalidRequest",
      title: "Too many tags",
      detail: `The session would carry ${started.tagCount} tags, including inherited crew tags. A session carries at most ${SESSION_TAG_LIMIT} tags.`,
      fix: `Reduce the total by ${started.tagCount - SESSION_TAG_LIMIT} tags and start the session again`,
    });
  }
  if (started.kind === "Draining") return refuse(503, deployInProgress("start again"));
  if (started.kind === "ReleaseUnreadable") return refuse(422, releaseUnreadable(started.detail, "start again"));
  return ok(started.started);
};

export const startSession = async (
  env: Env,
  caller: Caller,
  start: SessionStart,
  endpoint: string,
  now: number,
): Promise<Outcome<StartedSession>> => {
  const prepared = await prepareStart(env, caller, start, endpoint, now);
  if (!prepared.ok) return prepared;
  return placed(
    (await tenantOf(env, caller).call("startSession", { tenantId: caller.tenantId, input: prepared.value, now }))
      .started,
  );
};

export const startSessionFromIssue = async (
  env: Env,
  caller: Caller,
  start: SessionStartFromIssue,
  endpoint: string,
  now: number,
): Promise<Outcome<StartedSessionFromIssue>> => {
  const target = githubRepository(`${start.owner}/${start.name}`);
  if (target === null) return refuse(422, notARepository(`${start.owner}/${start.name}`));
  const issueUrl = `${repositoryUrl(target)}/issues/${start.issueNumber}`;
  const tenant = tenantOf(env, caller);
  const { persona } = await tenantApi(env.TENANT, caller.tenantId).call("getPersona", {
    tenantId: caller.tenantId,
    personaId: start.personaId,
  });
  if (persona === null) return personaNotFound(start.personaId);
  const { read: token } = await tenantApi(env.TENANT, caller.tenantId).call("repositoryReadToken", {
    tenantId: caller.tenantId,
    personaId: start.personaId,
    repository: target,
    now,
    permissions: { issues: "read" },
  });
  if (token.kind === "Refused") {
    return refuse(409, {
      code: "RepositoryUnreadable",
      title: "Repository unreadable",
      detail: token.detail,
      fix: "Give the GitHub App installation or the persona's GITHUB_TOKEN read access to the repository, then start again",
    });
  }
  const read = await readIssue(
    (url, init) => fetch(url, init),
    env.GITHUB_API_ORIGIN,
    token.token,
    target,
    start.issueNumber,
  );
  if (!read.ok && (read.status === 404 || read.status === 410)) {
    return refuse(404, {
      code: "IssueNotFound",
      title: "No such issue",
      detail: `${issueUrl} does not exist or was deleted: ${read.detail}`,
      fix: `List the open issues of ${target.owner}/${target.name} and start from one of them`,
    });
  }
  if (!read.ok) {
    return refuse(409, {
      code: "RepositoryUnreadable",
      title: "Issue unreadable",
      detail: `${issueUrl} could not be read: ${read.detail}`,
      fix: "Give the GitHub App installation or the persona's GITHUB_TOKEN read access to the repository's issues, then start again",
    });
  }
  const issue = read.value;
  if (issue.pull_request !== undefined || issue.state !== "open") {
    return refuse(409, {
      code: "IssueNotOpen",
      title: "Issue not open",
      detail: `${issue.html_url} is ${issue.pull_request === undefined ? `a ${issue.state} issue` : "a pull request"}, and a session starts from an open issue only`,
      fix: `List the open issues of ${target.owner}/${target.name} and start from one of them`,
    });
  }
  const branch = ticketBranch(issue);
  const prompt = ticketPrompt({
    owner: target.owner,
    repo: target.name,
    issue: { number: issue.number, title: issue.title, body: issue.body ?? "", url: issue.html_url },
    branch,
  });
  const prepared = await prepareStart(
    env,
    caller,
    { personaId: start.personaId, repository: repositoryUrl(target), model: start.model, prompt, tags: start.tags },
    endpoint,
    now,
  );
  if (!prepared.ok) return prepared;
  return placed(
    (
      await tenant.call("startSessionFromIssue", {
        tenantId: caller.tenantId,
        input: prepared.value,
        issue: { issueNumber: issue.number, title: issue.title, htmlUrl: issue.html_url, branch },
        now,
      })
    ).started,
  );
};

export const getSession = async (env: Env, caller: Caller, sessionId: string): Promise<Outcome<Session>> => {
  const { session } = await tenantOf(env, caller).call("getSession", { tenantId: caller.tenantId, sessionId });
  return session === null ? sessionNotFound(sessionId) : ok(session);
};

export const listSessions = async (env: Env, caller: Caller, query: SessionListQuery): Promise<Outcome<Session[]>> => {
  const filter: SessionFilter = {};
  if (query.state !== undefined) filter.state = query.state;
  if (query.hostId !== undefined) filter.hostId = query.hostId;
  if (query.lastTurnBefore !== undefined) filter.lastTurnBefore = Date.parse(query.lastTurnBefore);
  if (query.tag !== undefined) filter.tags = query.tag;
  if (query.triggerId !== undefined) filter.triggerId = query.triggerId;
  return ok((await tenantOf(env, caller).call("listSessions", { tenantId: caller.tenantId, filter })).sessions);
};

export const refusedGoal = (session: Session, send: TurnSend): Refused | null => {
  if (send.goal === undefined) return null;
  const goalFold = GOAL_FOLDS.get(session.harness);
  if (goalFold === undefined) {
    return refuse(400, {
      code: "InvalidRequest",
      title: "The harness takes no goal",
      detail: `session ${session.sessionId} runs ${session.harness}, which takes no goal; ${[...GOAL_FOLDS.keys()].join(", ")} takes one`,
      fix: "Send the turn without goal, and state the condition in the prompt",
    });
  }
  const length = goalFold.fold(send.prompt, send.goal, GOAL_TURN_CAP).length;
  if (length <= goalFold.limit) return null;
  return refuse(400, {
    code: "InvalidRequest",
    title: "Prompt and goal too long",
    detail: `the prompt and goal make a goal message of ${length} characters, and ${session.harness} takes at most ${goalFold.limit}`,
    fix: `Shorten the prompt or the goal by ${length - goalFold.limit} characters, then send again`,
  });
};

export const sendTurn = async (
  env: Env,
  caller: Caller,
  sessionId: string,
  send: TurnSend,
  now: number,
): Promise<Outcome<Turn>> => {
  const tenant = tenantOf(env, caller);
  const { session } = await tenant.call("getSession", { tenantId: caller.tenantId, sessionId });
  if (session === null) return sessionNotFound(sessionId);
  if (session.state === "Archived") return sessionArchived(sessionId, "turns");
  const goal = refusedGoal(session, send);
  if (goal !== null) return goal;
  const hosts = await listHostRecords(env, caller.tenantId);
  const { sent } = await tenant.call("sendTurn", {
    tenantId: caller.tenantId,
    sessionId,
    send,
    hosts,
    now,
    caller: caller.origin,
  });
  if (sent.kind === "Sent") return ok(sent.turn);
  if (sent.kind === "Stranded") return stranded(session, hosts, sent.missingTurnIds);
  if (sent.kind === "Unplaced") return unplaced(sent.hosts, "send the turn again");
  if (sent.kind === "Draining") return refuse(503, deployInProgress("send the turn again"));
  if (sent.kind === "ReleaseUnreadable") return refuse(422, releaseUnreadable(sent.detail, "send the turn again"));
  if (sent.kind === "NotFound") return sessionNotFound(sessionId);
  if (sent.kind === "Archived") return sessionArchived(sessionId, "turns");
  if (sent.kind === "Stopping") {
    return refuse(409, {
      code: "SessionStopping",
      title: "Session stopping",
      detail: `session ${sessionId} is stopping: its host is snapshotting it and tearing its box down`,
      fix: `Wait until session ${sessionId} reads Stopped or Idle, then send again`,
    });
  }
  if (sent.kind === "Failed") {
    return refuse(409, {
      code: "SessionFailed",
      title: "Session failed",
      detail: `session ${sessionId} could not clone ${session.repository} and takes no more turns; turn ${session.lastTurnId} failed RepositoryCloneFailed`,
      fix: `Read the failure of turn ${session.lastTurnId}, archive the session, and start a new session on a repository that exists, as https://github.com/owner/name`,
    });
  }
  if (sent.kind === "ConnectorDisconnected") return connectorDisconnected(sent.names);
  return credentialRefused(sent.refusal, `the secret set of persona ${sent.personaId}`, session.harness, "send again");
};

export const stopSession = async (
  env: Env,
  caller: Caller,
  sessionId: string,
  query: SessionStopQuery,
  now: number,
): Promise<Outcome<Session>> => {
  const tenant = tenantOf(env, caller);
  const { session } = await tenant.call("getSession", { tenantId: caller.tenantId, sessionId });
  if (session === null) return sessionNotFound(sessionId);
  if (session.state === "Archived") return sessionArchived(sessionId, "stop");
  if (session.state !== "Stopped" && session.state !== "Stopping" && session.state !== "Failed") {
    const offline = await hostOffline(env, caller, session, "stop the session again");
    if (offline !== null) return offline;
  }
  const cancelledBy = query.cancelTurn === true ? (await whoamiOf(env.DB, caller)).principal.email : null;
  const { stopped } = await tenant.call("stopSession", { tenantId: caller.tenantId, sessionId, cancelledBy, now });
  if (stopped.kind === "Stopping") return ok(stopped.session);
  if (stopped.kind === "NotFound") return sessionNotFound(sessionId);
  if (stopped.kind === "Archived") return sessionArchived(sessionId, "stop");
  return refuse(409, {
    code: "TurnInFlight",
    title: "A turn is running",
    detail: `session ${sessionId} is still running turn ${stopped.turnId}, and a stop without cancelTurn waits for no turn`,
    fix: `Wait for turn ${stopped.turnId} to finish and stop again, or stop with cancelTurn true to cancel it`,
  });
};

export const archiveSession = async (
  env: Env,
  caller: Caller,
  sessionId: string,
  now: number,
): Promise<Outcome<Session>> => {
  const tenant = tenantOf(env, caller);
  const { session } = await tenant.call("getSession", { tenantId: caller.tenantId, sessionId });
  if (session === null) return sessionNotFound(sessionId);
  if (session.state === "Idle" || session.state === "Unknown") {
    const offline = await hostOffline(env, caller, session, "archive the session again");
    if (offline !== null) return offline;
  }
  const { archived } = await tenant.call("archiveSession", { tenantId: caller.tenantId, sessionId, now });
  if (archived.kind === "Archived") return ok(archived.session);
  if (archived.kind === "NotFound") return sessionNotFound(sessionId);
  return refuse(409, {
    code: "SessionNotStopped",
    title: "Session not stopped",
    detail: `session ${sessionId} is ${archived.state}, and only an Idle, Stopped or Failed session can be archived`,
    fix: `Wait until session ${sessionId} reads Idle or Stopped, then archive again`,
  });
};

export const setSessionTags = async (
  env: Env,
  caller: Caller,
  sessionId: string,
  tags: string[],
  now: number,
): Promise<Outcome<Session>> => {
  const tenant = tenantOf(env, caller);
  const { session } = await tenant.call("getSession", { tenantId: caller.tenantId, sessionId });
  if (session === null) return sessionNotFound(sessionId);
  if (session.state === "Archived") return sessionArchived(sessionId, "tags");
  const { tagged } = await tenant.call("setSessionTags", { tenantId: caller.tenantId, sessionId, tags, now });
  return tagged.kind === "Tagged" ? ok(tagged.session) : sessionNotFound(sessionId);
};

export const patchSessionTags = async (
  env: Env,
  caller: Caller,
  sessionId: string,
  patch: z.infer<typeof SessionTagsPatchSchema>,
  now: number,
): Promise<Outcome<Session>> => {
  const tenant = tenantOf(env, caller);
  const { session } = await tenant.call("getSession", { tenantId: caller.tenantId, sessionId });
  if (session === null) return sessionNotFound(sessionId);
  if (session.state === "Archived") return sessionArchived(sessionId, "tags");
  const { tagged } = await tenant.call("patchSessionTags", { tenantId: caller.tenantId, sessionId, patch, now });
  if (tagged.kind === "Tagged") return ok(tagged.session);
  if (tagged.kind === "NotFound") return sessionNotFound(sessionId);
  return refuse(422, {
    code: "InvalidRequest",
    title: "Too many tags",
    detail: `session ${sessionId} would carry ${tagged.tagCount} tags, and a session carries at most ${SESSION_TAG_LIMIT}`,
    fix: `Add fewer tags or remove ${tagged.tagCount - SESSION_TAG_LIMIT} more in the same patch, then send it again`,
  });
};

export const deleteSession = async (env: Env, caller: Caller, sessionId: string): Promise<Outcome<null>> => {
  const tenant = tenantOf(env, caller);
  const { session } = await tenant.call("getSession", { tenantId: caller.tenantId, sessionId });
  if (session === null) return sessionNotFound(sessionId);
  if (session.state === "Idle" || session.state === "Unknown") {
    const offline = await hostOffline(env, caller, session, "delete the session again");
    if (offline !== null) return offline;
  }
  const { deleted } = await tenant.call("deleteSession", { tenantId: caller.tenantId, sessionId });
  if (deleted.kind === "Deleted") return ok(null);
  if (deleted.kind === "NotFound") return sessionNotFound(sessionId);
  if (deleted.state === "Archived") {
    return refuse(409, {
      code: "SessionNotStopped",
      title: "Session snapshot in use",
      detail: `a turn of another session is restoring from the prebuild that session ${sessionId} built, so its snapshot stays until that restore ends`,
      fix: `Wait for that turn to start running, then delete session ${sessionId} again`,
    });
  }
  return refuse(409, {
    code: "SessionNotStopped",
    title: "Session not stopped",
    detail: `session ${sessionId} is ${deleted.state}, and only an Idle, Stopped, Failed or Archived session can be deleted`,
    fix: `Wait until session ${sessionId} reads Idle or Stopped, then delete again`,
  });
};

export const listTurns = async (env: Env, caller: Caller, sessionId: string): Promise<Outcome<Turn[]>> => {
  const { turns } = await tenantOf(env, caller).call("listTurns", { tenantId: caller.tenantId, sessionId });
  return turns === null ? sessionNotFound(sessionId) : ok(turns);
};

export const getTurn = async (env: Env, caller: Caller, turnId: string): Promise<Outcome<Turn>> => {
  const { turn } = await tenantOf(env, caller).call("getTurn", { tenantId: caller.tenantId, turnId });
  return turn === null ? turnNotFound(turnId) : ok(turn);
};

export const cancelTurn = async (env: Env, caller: Caller, turnId: string, now: number): Promise<Outcome<Turn>> => {
  const cancelledBy = (await whoamiOf(env.DB, caller)).principal.email;
  const { cancelled } = await tenantOf(env, caller).call("cancelTurn", {
    tenantId: caller.tenantId,
    turnId,
    cancelledBy,
    now,
  });
  if (cancelled.kind === "Cancelled") return ok(cancelled.turn);
  if (cancelled.kind === "NotFound") return turnNotFound(turnId);
  return refuse(409, {
    code: "TurnNotWaiting",
    title: "Turn not waiting",
    detail: `turn ${turnId} is ${cancelled.state} and no longer waits behind another turn, so it cannot be cancelled`,
    fix: "Cancel only a turn that waits Offered behind another turn of its session; stop the session with cancelTurn true to end a running turn",
  });
};

export const steerTurn = async (
  env: Env,
  caller: Caller,
  turnId: string,
  prompt: string,
  now: number,
): Promise<Outcome<Steer>> => {
  const { sent } = await tenantOf(env, caller).call("steerTurn", {
    tenantId: caller.tenantId,
    turnId,
    steer: { prompt },
    now,
  });
  if (sent.kind === "Sent") return ok(sent.steer);
  if (sent.kind === "NotFound") return turnNotFound(turnId);
  if (sent.kind === "NotRunning") {
    return refuse(409, {
      code: "TurnNotRunning",
      title: "Turn not running",
      detail: `turn ${turnId} is ${sent.state}, and only a Running turn takes a steer`,
      fix: "Send the prompt as the session's next turn instead",
    });
  }
  return refuse(409, {
    code: "SteerUnsupported",
    title: "Turn takes no steer",
    detail: `turn ${turnId} runs in a box that reads no steer: only a Claude Code turn on a host that runs connectors, with a persona .claude/settings.json that is a JSON object, takes one`,
    fix: "Send the prompt as the session's next turn instead",
  });
};

export const listSteers = async (env: Env, caller: Caller, turnId: string): Promise<Outcome<Steer[]>> => {
  const { steers } = await tenantOf(env, caller).call("listSteers", { tenantId: caller.tenantId, turnId });
  return steers === null ? turnNotFound(turnId) : ok(steers);
};

export const getTurnFailure = async (env: Env, caller: Caller, turnId: string): Promise<Outcome<TurnFailure>> => {
  const tenant = tenantOf(env, caller);
  const { failure } = await tenant.call("getTurnFailure", { tenantId: caller.tenantId, turnId });
  if (failure !== null) return ok(failure);
  const { turn } = await tenant.call("getTurn", { tenantId: caller.tenantId, turnId });
  if (turn === null) return turnNotFound(turnId);
  return refuse(404, {
    code: "NotFound",
    title: "Turn did not fail",
    detail: `turn ${turnId} is ${turn.state}, and only a Failed turn has a failure`,
    fix: `Read turn ${turnId}`,
  });
};

const readChunk = async (env: Env, storageKey: string, range: Range): Promise<TranscriptLine[]> => {
  const object = await env.STORE.get(storageKey, { range });
  if (object === null) throw new Error(`transcript chunk ${storageKey} is indexed but missing from the store`);
  return decodeLines(await object.text());
};

const linesOf = async (env: Env, cursor: TranscriptCursor): Promise<TranscriptLine[]> =>
  cursor.kind === "Lines" ? [] : readChunk(env, cursor.storageKey, cursor.range);

const COMPACT_READ_RAW_BYTES_PER_PAGE_BYTE = 8;

const compactChunks = async (
  env: Env,
  prefix: string,
  cursor: TranscriptCursor,
  turnId: string | null,
  maxBytes: number,
): Promise<StoredChunk[]> => {
  if (cursor.kind === "Lines") return [];
  const listed = await chunksFrom(env.STORE, prefix, cursor.storageKey, cursor.range.length);
  const other = turnId === null ? -1 : listed.findIndex((chunk) => chunk.turnId !== turnId);
  return chunksWithin(other === -1 ? listed : listed.slice(0, other), maxBytes * COMPACT_READ_RAW_BYTES_PER_PAGE_BYTE);
};

export const byTurn = (lines: readonly TranscriptLine[]): CompactTranscriptTurn[] => {
  const turns: CompactTranscriptTurn[] = [];
  let previousAt: number | null = null;
  for (const { turnId, lineSeq, text, createdAt } of lines) {
    const last = turns.at(-1);
    const durationMs = previousAt === null ? 0 : createdAt - previousAt;
    const line: CompactTranscriptLine = { lineSeq, text, createdAt, durationMs };
    if (last !== undefined && last.turnId === turnId) {
      last.lines.push(line);
      last.endedAt = createdAt;
    } else {
      turns.push({ turnId, lines: [line], startedAt: createdAt, endedAt: createdAt });
    }
    previousAt = createdAt;
  }
  return turns;
};

const COMPACT_HARNESSES = [
  ...new Set(HARNESS_CATALOG.filter((entry) => entry.compactTranscript).map((entry) => entry.harness)),
];

export const readTranscript = async (
  env: Env,
  caller: Caller,
  sessionId: string,
  query: TranscriptQuery,
): Promise<Outcome<TranscriptPage>> => {
  const compact = query.compact ?? false;
  const maxBytes = query.maxBytes ?? DEFAULT_PAGE_BYTES;
  const chunkLines = settingsOf(env).transcriptChunkLines;
  const limit = query.limit ?? (compact ? null : chunkLines);
  const readAfter = async (page: Page) =>
    (
      await tenantOf(env, caller).call("transcriptCursor", {
        tenantId: caller.tenantId,
        sessionId,
        after: page.cursor,
        turnId: query.turnId ?? null,
      })
    ).cursor;
  let page = emptyPage(query.after ?? 0);
  const cursor = await readAfter(page);
  if (cursor === null) return sessionNotFound(sessionId);
  const compactor = compact ? compactorOf(cursor.harness) : null;
  if (compact && compactor === null) {
    return refuse(422, {
      code: "InvalidRequest",
      title: "No compact form for the harness",
      detail: `session ${sessionId} runs ${cursor.harness}, whose transcript has no compact form; ${COMPACT_HARNESSES.join(", ")} have one`,
      fix: "Read the transcript without compact",
    });
  }
  const unreadable = (lineSeq: number) =>
    refuse(422, {
      code: "TranscriptLineUnreadable",
      title: "Transcript line is not JSON",
      detail: `line ${lineSeq} of session ${sessionId} is not JSON, so the transcript has no compact form from there`,
      fix: "Read the transcript without compact",
    });
  if (compactor !== null) {
    const prefix = transcriptPrefix(caller.tenantId, sessionId);
    for (const chunk of await compactChunks(env, prefix, cursor, query.turnId ?? null, maxBytes)) {
      const read = await readChunk(env, chunk.storageKey, { offset: 0, length: chunk.size });
      const paged = pageOf(
        page,
        read.filter((line) => line.lineSeq > page.cursor),
        compactor,
        limit,
        maxBytes,
      );
      if (!paged.ok) return unreadable(paged.lineSeq);
      page = paged.page;
      if (page.full) break;
    }
    return ok({
      form: "Compact" as const,
      sessionId,
      sessionState: cursor.sessionState,
      turns: byTurn(page.lines),
      cursor: page.cursor,
      finished: !cursor.inFlight && page.cursor >= cursor.lastLineSeq,
    });
  }
  let read = cursor;
  for (;;) {
    const fetched = (await linesOf(env, read)).filter((line) => line.lineSeq > page.cursor);
    const paged = pageOf(page, fetched, null, limit, maxBytes);
    if (!paged.ok) return unreadable(paged.lineSeq);
    page = paged.page;
    if (page.full || fetched.length === 0 || page.cursor >= read.lastLineSeq) {
      const finished = !read.inFlight && page.cursor >= read.lastLineSeq;
      return ok(
        TranscriptPageSchema.parse({
          form: "Raw",
          sessionState: read.sessionState,
          lines: page.lines,
          cursor: page.cursor,
          finished,
        }),
      );
    }
    const next = await readAfter(page);
    if (next === null) return sessionNotFound(sessionId);
    read = next;
  }
};

export const listStopFailures = async (
  env: Env,
  caller: Caller,
  sessionId: string,
): Promise<Outcome<StopFailure[]>> => {
  const { failures } = await tenantOf(env, caller).call("listStopFailures", { tenantId: caller.tenantId, sessionId });
  return failures === null ? sessionNotFound(sessionId) : ok(failures);
};

export const listSnapshots = async (env: Env, caller: Caller, sessionId: string): Promise<Outcome<Snapshot[]>> => {
  const { snapshots } = await tenantOf(env, caller).call("listSnapshots", { tenantId: caller.tenantId, sessionId });
  return snapshots === null ? sessionNotFound(sessionId) : ok(snapshots);
};

export const listCredentialHandovers = async (
  env: Env,
  caller: Caller,
  sessionId: string,
): Promise<Outcome<CredentialHandover[]>> => {
  const { handovers } = await tenantOf(env, caller).call("listCredentialHandovers", {
    tenantId: caller.tenantId,
    sessionId,
  });
  return handovers === null ? sessionNotFound(sessionId) : ok(handovers);
};

export const getSnapshot = async (env: Env, caller: Caller, snapshotId: string): Promise<Outcome<Snapshot>> => {
  const { snapshot } = await tenantOf(env, caller).call("getSnapshot", { tenantId: caller.tenantId, snapshotId });
  if (snapshot !== null) return ok(snapshot);
  return refuse(404, {
    code: "NotFound",
    title: "No such snapshot",
    detail: `your tenant has no stored snapshot ${snapshotId}`,
    fix: "List the session's snapshots and use one of their ids",
  });
};

const queryOf = (url: URL, numeric: string[], flags: string[] = []): Record<string, unknown> =>
  Object.fromEntries(
    [...url.searchParams].map(([name, value]) => [
      name,
      numeric.includes(name) && /^\d+$/.test(value)
        ? Number(value)
        : flags.includes(name) && (value === "true" || value === "false")
          ? value === "true"
          : value,
    ]),
  );

const invalidQuery = (operation: string, error: z.ZodError): Response =>
  problem(400, {
    code: "InvalidRequest",
    title: "Invalid query",
    detail: `${operation} refused the query: ${issues(error)}`,
    fix: "Send query parameters that match the operation's schema in typespec",
  });

const answer = <T>(outcome: Outcome<T>): Response =>
  outcome.ok ? json(outcome.value) : problem(outcome.status, outcome.problem);

const SESSION_PATH =
  /^\/v1\/sessions\/([^/]+)(\/turns|\/transcript|\/snapshots|\/credential-handovers|\/stop-failures|\/stop|\/archive|\/tags)?$/;
const SESSION_GETS = ["", "/turns", "/transcript", "/snapshots", "/credential-handovers", "/stop-failures"];
const SESSION_POSTS = ["/turns", "/stop", "/archive"];
const SESSION_TAG_METHODS = ["PUT", "PATCH"];
const FROM_ISSUE_PATH = "/v1/sessions/from-issue";
const TURN_PATH = /^\/v1\/turns\/([^/]+)(\/failure|\/cancel|\/steers)?$/;
const SNAPSHOT_PATH = /^\/v1\/snapshots\/([^/]+)$/;

type Authenticate = (request: Request, env: Env) => Promise<Caller | Response>;

const sessionRoute = async (
  request: Request,
  url: URL,
  env: Env,
  caller: Caller,
  raw: string,
  action: string | undefined,
): Promise<Response> => {
  const path = SessionPathSchema.safeParse({ sessionId: raw });
  if (!path.success) return answer(sessionNotFound(raw));
  const { sessionId } = path.data;
  if (action === "/turns" && request.method === "POST") {
    const body = await parseBody(request, TurnSendSchema, "sessions.sendTurn");
    if (!body.ok) return body.response;
    return answer(await sendTurn(env, caller, sessionId, body.value, Date.now()));
  }
  if (action === "/stop") {
    const query = SessionStopQuerySchema.safeParse(queryOf(url, [], ["cancelTurn"]));
    if (!query.success) return invalidQuery("sessions.stop", query.error);
    return answer(await stopSession(env, caller, sessionId, query.data, Date.now()));
  }
  if (action === "/archive") return answer(await archiveSession(env, caller, sessionId, Date.now()));
  if (action === "/tags" && request.method === "PUT") {
    const body = await parseBody(request, SessionTagsSchema, "sessions.setTags");
    if (!body.ok) return body.response;
    return answer(await setSessionTags(env, caller, sessionId, body.value.tags, Date.now()));
  }
  if (action === "/tags") {
    const body = await parseBody(request, SessionTagsPatchSchema, "sessions.patchTags");
    if (!body.ok) return body.response;
    return answer(await patchSessionTags(env, caller, sessionId, body.value, Date.now()));
  }
  if (request.method === "DELETE") {
    const deleted = await deleteSession(env, caller, sessionId);
    return deleted.ok ? noContent() : answer(deleted);
  }
  if (action === "/turns") return answer(await listTurns(env, caller, sessionId));
  if (action === "/snapshots") return answer(await listSnapshots(env, caller, sessionId));
  if (action === "/credential-handovers") return answer(await listCredentialHandovers(env, caller, sessionId));
  if (action === "/stop-failures") return answer(await listStopFailures(env, caller, sessionId));
  if (action === "/transcript") {
    const query = TranscriptQuerySchema.safeParse(queryOf(url, ["after", "limit", "maxBytes"], ["compact"]));
    if (!query.success) return invalidQuery("sessions.readTranscript", query.error);
    return answer(await readTranscript(env, caller, sessionId, query.data));
  }
  return answer(await getSession(env, caller, sessionId));
};

export const handleSessions = async (
  request: Request,
  url: URL,
  env: Env,
  authenticate: Authenticate,
): Promise<Response | null> => {
  const { pathname } = url;
  const session = SESSION_PATH.exec(pathname);
  const turn = TURN_PATH.exec(pathname);
  const snapshot = SNAPSHOT_PATH.exec(pathname);
  const posting = request.method === "POST";
  const routed =
    (pathname === FROM_ISSUE_PATH && posting) ||
    (pathname === "/v1/sessions" && (posting || request.method === "GET")) ||
    (session !== null &&
      (posting ? SESSION_POSTS : request.method === "GET" ? SESSION_GETS : []).includes(session[2] ?? "")) ||
    (session?.[2] === "/tags" && SESSION_TAG_METHODS.includes(request.method)) ||
    (session !== null && request.method === "DELETE" && session[2] === undefined) ||
    (turn !== null &&
      (posting ? ["/cancel", "/steers"].includes(turn[2] ?? "") : request.method === "GET" && turn[2] !== "/cancel")) ||
    (snapshot !== null && request.method === "GET");
  if (!routed) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
  if (pathname === FROM_ISSUE_PATH) {
    const body = await parseBody(request, SessionStartFromIssueSchema, "sessions.startFromIssue");
    if (!body.ok) return body.response;
    return answer(await startSessionFromIssue(env, caller, body.value, url.origin, Date.now()));
  }
  if (pathname === "/v1/sessions" && posting) {
    const body = await parseBody(request, SessionStartSchema, "sessions.start");
    if (!body.ok) return body.response;
    return answer(await startSession(env, caller, body.value, url.origin, Date.now()));
  }
  if (pathname === "/v1/sessions") {
    const tag = url.searchParams.getAll("tag");
    const query = SessionListQuerySchema.safeParse({ ...queryOf(url, []), ...(tag.length > 0 ? { tag } : {}) });
    if (!query.success) return invalidQuery("sessions.list", query.error);
    return answer(await listSessions(env, caller, query.data));
  }
  if (session?.[1] !== undefined) {
    return sessionRoute(request, url, env, caller, decodeURIComponent(session[1]), session[2]);
  }
  if (turn?.[1] !== undefined) {
    const raw = decodeURIComponent(turn[1]);
    const path = TurnPathSchema.safeParse({ turnId: raw });
    if (!path.success) return answer(turnNotFound(raw));
    if (turn[2] === "/cancel") return answer(await cancelTurn(env, caller, path.data.turnId, Date.now()));
    if (turn[2] === "/failure") return answer(await getTurnFailure(env, caller, path.data.turnId));
    if (turn[2] === "/steers" && posting) {
      const body = await parseBody(request, SteerCreateSchema, "turns.steer");
      if (!body.ok) return body.response;
      return answer(await steerTurn(env, caller, path.data.turnId, body.value.prompt, Date.now()));
    }
    if (turn[2] === "/steers") return answer(await listSteers(env, caller, path.data.turnId));
    return answer(await getTurn(env, caller, path.data.turnId));
  }
  return answer(await getSnapshot(env, caller, decodeURIComponent(snapshot?.[1] ?? "")));
};
