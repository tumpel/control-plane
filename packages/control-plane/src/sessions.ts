import { type CredentialRefusal, checkModelCredential, credentialProblem } from "@tumpel/api/credentials";
import {
  BoxMemoryLimit,
  SessionListQuerySchema,
  SessionPathSchema,
  SessionStartFromIssueSchema,
  SessionStartSchema,
  SessionStopQuerySchema,
  TranscriptPageSchema,
  TranscriptQuerySchema,
  TurnPathSchema,
  TurnSendSchema,
  TurnWaitQuerySchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { compactorOf } from "./compact.ts";
import { DISCONNECTED_FIX, disconnectedDetail } from "./connector-rows.ts";
import { deployInProgress } from "./deploy-drain.ts";
import { githubRepository, notARepository, readIssue, repositoryUrl } from "./github.ts";
import { GOAL_FOLDS, HARNESS_CATALOG, pinnedEntry } from "./harness-catalog.ts";
import { type HostRecord, hostOf, listHosts, type Outcome, type Refused } from "./hosts.ts";
import { issues, json, parseBody, problem } from "./http.ts";
import { type Caller, whoamiOf } from "./identity.ts";
import type { Env } from "./index.ts";
import type { Unplaceable } from "./placement.ts";
import { releaseUnreadable } from "./releases.ts";
import { unreadableSecretSet } from "./secret-members.ts";
import { settingsOf } from "./settings.ts";
import { tenantApi } from "./tenant-api.ts";
import type {
  CredentialHandover,
  NewSession,
  Session,
  SessionFilter,
  SessionStart,
  Snapshot,
  Started,
  StartedSession,
  StartedSessionFromIssue,
  StopFailure,
  TranscriptCursor,
  Turn,
  TurnFailure,
  TurnSend,
} from "./tenant-sessions.ts";
import { ticketBranch, ticketPrompt } from "./ticket-prompt.ts";
import { DEFAULT_PAGE_BYTES, decodeLines, emptyPage, type Page, pageOf, type TranscriptLine } from "./transcript.ts";

export type TranscriptPage = z.infer<typeof TranscriptPageSchema>;
export type TranscriptQuery = z.infer<typeof TranscriptQuerySchema>;
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;
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

const refuse = (status: Refused["status"], refused: Refused["problem"]): Refused => ({
  ok: false,
  status,
  problem: refused,
});

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
  if (host?.state === "Online") return null;
  return refuse(409, {
    code: "HostOffline",
    title: "Host offline",
    detail:
      host === null
        ? "the session's host is no longer enrolled"
        : `the session runs on host ${host.name}, which is ${host.state}`,
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

export const why = (refused: Unplaceable): string => {
  const named = refused.host.name;
  if (refused.reason === "NotOnline") return `${named} is ${refused.host.state}`;
  if (refused.reason === "NoImage") {
    const { harness, harnessVersion, architectures } = refused.image;
    const carried =
      architectures.length === 0
        ? `no ${harness} ${harnessVersion} guest image`
        : `${harness} ${harnessVersion} guest images for ${architectures.join(", ")} only`;
    return `${named} is ${refused.host.architecture}, and the current release carries ${carried}`;
  }
  if (refused.reason === "NoMemory") {
    return `${named} has ${refused.usage.memoryAvailableMib} MiB of memory available, and the persona's boxes need ${refused.boxMemoryMib} MiB`;
  }
  if (refused.reason === "NoConnectors") {
    return `${named} runs a supervisor too old to serve connectors`;
  }
  if (refused.reason === "MemoryFull") {
    return `${named} gives boxes ${refused.usage.memoryBudgetMib} MiB of memory and its boxes hold ${refused.usage.memoryHeldMib} MiB of it, and the persona's boxes need ${refused.boxMemoryMib} MiB`;
  }
  if (refused.reason === "NoDisk") {
    return `${named} gives box disks ${refused.usage.diskBudgetMib} MiB and its boxes hold ${refused.usage.diskHeldMib} MiB of it, and the persona's boxes need ${refused.boxDiskMib} MiB`;
  }
  return `${named} runs a turn in all ${refused.usage.boxCapacity} of its box slots`;
};

export const placeableFix = (hosts: Unplaceable[], retry: string): string => {
  const [lacking] = hosts.flatMap((each) => (each.reason === "NoImage" ? [each.image] : []));
  if (lacking === undefined && hosts.some(({ reason }) => reason === "NoMemory")) {
    return `Lower the persona's boxMemoryMib toward the ${BoxMemoryLimit.DefaultMib} MiB default, free memory on a host, or enrol a host with more memory, then ${retry}`;
  }
  if (lacking === undefined && hosts.some(({ reason }) => reason === "NoConnectors")) {
    return `Let a host update its supervisor to the current release, or use a persona without connectors, then ${retry}`;
  }
  if (lacking === undefined && hosts.some(({ reason }) => reason === "NoDisk")) {
    return `Lower the persona's boxDiskMib toward the 32768 MiB default, free disk on a host, or enrol a host with more disk, then ${retry}`;
  }
  if (lacking === undefined) {
    return `Start the supervisor on a host, or enrol a new host, then ${retry}`;
  }
  const { harness, harnessVersion, architectures } = lacking;
  if (architectures.length === 0) {
    return `Pin a harness version the current release carries, or ask the operator, who publishes releases, for one that carries a ${harness} ${harnessVersion} guest image, then ${retry}`;
  }
  return `Start the supervisor on an ${architectures.join(" or ")} host, or enrol a new one, then ${retry}`;
};

const unplaced = (hosts: Unplaceable[], retry: string): Refused => {
  if (hosts.length === 0) {
    return refuse(409, {
      code: "NoHostAvailable",
      title: "No host online",
      detail: "your tenant has no hosts",
      fix: `Enrol a host and start the supervisor on it, then ${retry}`,
    });
  }
  const detail = hosts.map(why).join(", ");
  if (hosts.some(({ reason }) => reason === "MemoryFull")) {
    return refuse(409, {
      code: "PoolExhausted",
      title: "Every host's box memory is in use",
      detail: `no host of your tenant has memory for another box: ${detail}`,
      fix: `Wait for a running turn to finish, lower the persona's boxMemoryMib, or enrol another host, then ${retry}`,
    });
  }
  if (hosts.some(({ reason }) => reason === "Full")) {
    return refuse(409, {
      code: "PoolExhausted",
      title: "Every box slot is running a turn",
      detail: `no host of your tenant has a free box slot: ${detail}`,
      fix: `Wait for a running turn to finish, raise boxCapacity in runtime.json and rerun tumpel-supervisor install, or enrol another host, then ${retry}`,
    });
  }
  return refuse(409, {
    code: "NoHostAvailable",
    title: "No host can take the session",
    detail: `no host of your tenant can take a session: ${detail}`,
    fix: placeableFix(hosts, retry),
  });
};

const stranded = (session: Session, hosts: HostRecord[], missingTurnIds: string[]): Refused => {
  const host = hosts.find((listed) => listed.hostId === session.hostId);
  if (host === undefined) {
    throw new Error(`session ${session.sessionId} runs on host ${session.hostId}, which its tenant does not list`);
  }
  return refuse(409, {
    code: "HostOffline",
    title: "Host offline",
    detail: `the session runs on host ${host.name}, which is ${host.state}, and its snapshots miss ${missingTurnIds.length} completed ${missingTurnIds.length === 1 ? "turn" : "turns"}, so it cannot move to another host`,
    fix:
      host.state === "Revoked"
        ? "The host was revoked and cannot snapshot those turns; enrol a new host"
        : "Start tumpel-supervisor run on that host so it snapshots those turns, then send the turn again",
  });
};

const tenantOf = (env: Env, caller: Caller) => env.TENANT.getByName(caller.tenantId);

const personaNotFound = (personaId: string): Refused =>
  refuse(404, {
    code: "NotFound",
    title: "No such persona",
    detail: `your tenant owns no persona ${personaId}`,
    fix: "List your personas and start with one of their ids",
  });

const prepareStart = async (
  env: Env,
  caller: Caller,
  start: SessionStart,
  endpoint: string,
  now: number,
): Promise<Outcome<NewSession>> => {
  const target = githubRepository(start.repository);
  if (target === null) return refuse(422, notARepository(start.repository));
  const tenant = tenantOf(env, caller);
  const { persona } = await tenantApi(env.TENANT, caller.tenantId).call("getPersona", {
    tenantId: caller.tenantId,
    personaId: start.personaId,
  });
  if (persona === null) return personaNotFound(start.personaId);
  const entry = pinnedEntry(await tenant.listPins(), persona.harness);
  if (entry === undefined) {
    return refuse(422, {
      code: "HarnessNotInCatalog",
      title: "Harness not in the catalog",
      detail: `persona ${persona.name} runs ${persona.harness}, of which the catalog has no version your tenant can run; it holds ${HARNESS_CATALOG.map((listed) => `${listed.harness} ${listed.harnessVersion}`).join(", ")}`,
      fix: "Pin a listed version of that harness, or point the persona at a harness the catalog lists",
    });
  }
  const read = await tenant.getSecretSet(caller.tenantId, persona.secretSetId);
  if (read.kind === "NotFound") {
    throw new Error(`persona ${persona.personaId} names secret set ${persona.secretSetId}, which does not exist`);
  }
  if (read.kind === "Unreadable") return refuse(409, unreadableSecretSet("sessions.start", read));
  const { secretSet } = read;
  const credential = checkModelCredential(entry, secretSet.keys, start.model, now);
  if (credential.kind !== "Usable") {
    return credentialRefused(
      credential,
      `secret set ${secretSet.name} of persona ${persona.name}`,
      persona.harness,
      "start again",
    );
  }
  return ok({
    principalId: caller.principalId,
    hosts: await listHosts(env.DB, caller.tenantId),
    harness: entry.harness,
    harnessVersion: entry.harnessVersion,
    endpoint,
    start: { ...start, repository: repositoryUrl(target) },
  });
};

const connectorDisconnected = (names: string[]): Refused =>
  refuse(409, {
    code: "ConnectorDisconnected",
    title: "Connector not connected",
    detail: disconnectedDetail(names),
    fix: DISCONNECTED_FIX,
  });

export const placed = <T>(started: Started<T>): Outcome<T> => {
  if (started.kind === "Unplaced") return unplaced(started.hosts, "start again");
  if (started.kind === "ConnectorDisconnected") return connectorDisconnected(started.names);
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
  return placed(await tenantOf(env, caller).startSession(caller.tenantId, prepared.value, now));
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
  const token = await tenant.repositoryReadToken(caller.tenantId, start.personaId, target, now, { issues: "read" });
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
    { personaId: start.personaId, repository: repositoryUrl(target), model: start.model, prompt },
    endpoint,
    now,
  );
  if (!prepared.ok) return prepared;
  return placed(
    await tenant.startSessionFromIssue(
      caller.tenantId,
      prepared.value,
      { issueNumber: issue.number, title: issue.title, htmlUrl: issue.html_url, branch },
      now,
    ),
  );
};

export const getSession = async (env: Env, caller: Caller, sessionId: string): Promise<Outcome<Session>> => {
  const session = await tenantOf(env, caller).getSession(caller.tenantId, sessionId);
  return session === null ? sessionNotFound(sessionId) : ok(session);
};

export const listSessions = async (env: Env, caller: Caller, query: SessionListQuery): Promise<Outcome<Session[]>> => {
  const filter: SessionFilter = {};
  if (query.state !== undefined) filter.state = query.state;
  if (query.hostId !== undefined) filter.hostId = query.hostId;
  if (query.lastTurnBefore !== undefined) filter.lastTurnBefore = Date.parse(query.lastTurnBefore);
  return ok(await tenantOf(env, caller).listSessions(caller.tenantId, filter));
};

const refusedGoal = (session: Session, send: TurnSend): Refused | null => {
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
  const length = goalFold.fold(send.prompt, send.goal).length;
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
  const session = await tenant.getSession(caller.tenantId, sessionId);
  if (session === null) return sessionNotFound(sessionId);
  if (session.state === "Archived") return sessionArchived(sessionId, "turns");
  const goal = refusedGoal(session, send);
  if (goal !== null) return goal;
  const hosts = await listHosts(env.DB, caller.tenantId);
  const sent = await tenant.sendTurn(caller.tenantId, sessionId, send, hosts, now);
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
  if (sent.kind === "InFlight") {
    return refuse(409, {
      code: "TurnInFlight",
      title: "A turn is running",
      detail: `session ${sessionId} is still running turn ${sent.turnId}`,
      fix: `Wait for turn ${sent.turnId} to finish, then send again`,
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
  const session = await tenant.getSession(caller.tenantId, sessionId);
  if (session === null) return sessionNotFound(sessionId);
  if (session.state === "Archived") return sessionArchived(sessionId, "stop");
  if (session.state !== "Stopped" && session.state !== "Stopping" && session.state !== "Failed") {
    const offline = await hostOffline(env, caller, session, "stop the session again");
    if (offline !== null) return offline;
  }
  const cancelledBy = query.cancelTurn === true ? (await whoamiOf(env.DB, caller)).principal.email : null;
  const stopped = await tenant.stopSession(caller.tenantId, sessionId, cancelledBy, now);
  if (stopped.kind === "Stopping") return ok(stopped.session);
  if (stopped.kind === "NotFound") return sessionNotFound(sessionId);
  if (stopped.kind === "Archived") return sessionArchived(sessionId, "stop");
  if (stopped.kind === "CancelUnspoken") {
    return refuse(409, {
      code: "TurnInFlight",
      title: "A turn is running",
      detail: `session ${sessionId} is running turn ${stopped.turnId} on host ${stopped.host}, whose supervisor is too old to cancel a turn`,
      fix: `Wait for turn ${stopped.turnId} to finish, then stop again; the host updates its supervisor on its own once no box runs`,
    });
  }
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
  const session = await tenant.getSession(caller.tenantId, sessionId);
  if (session === null) return sessionNotFound(sessionId);
  if (session.state === "Idle") {
    const offline = await hostOffline(env, caller, session, "archive the session again");
    if (offline !== null) return offline;
  }
  const archived = await tenant.archiveSession(caller.tenantId, sessionId, now);
  if (archived.kind === "Archived") return ok(archived.session);
  if (archived.kind === "NotFound") return sessionNotFound(sessionId);
  return refuse(409, {
    code: "SessionNotStopped",
    title: "Session not stopped",
    detail: `session ${sessionId} is ${archived.state}, and only an Idle, Stopped or Failed session can be archived`,
    fix: `Wait until session ${sessionId} reads Idle or Stopped, then archive again`,
  });
};

export const listTurns = async (env: Env, caller: Caller, sessionId: string): Promise<Outcome<Turn[]>> => {
  const turns = await tenantOf(env, caller).listTurns(caller.tenantId, sessionId);
  return turns === null ? sessionNotFound(sessionId) : ok(turns);
};

export const getTurn = async (env: Env, caller: Caller, turnId: string): Promise<Outcome<Turn>> => {
  const turn = await tenantOf(env, caller).getTurn(caller.tenantId, turnId);
  return turn === null ? turnNotFound(turnId) : ok(turn);
};

export const waitTurns = async (
  env: Env,
  caller: Caller,
  turnIds: string[],
  timeoutSeconds: number,
): Promise<Outcome<Turn[]>> => {
  const waited = await tenantOf(env, caller).waitTurns(caller.tenantId, turnIds, timeoutSeconds);
  return waited.kind === "Read" ? ok(waited.turns) : turnNotFound(waited.turnId);
};

export const getTurnFailure = async (env: Env, caller: Caller, turnId: string): Promise<Outcome<TurnFailure>> => {
  const tenant = tenantOf(env, caller);
  const failure = await tenant.getTurnFailure(caller.tenantId, turnId);
  if (failure !== null) return ok(failure);
  const turn = await tenant.getTurn(caller.tenantId, turnId);
  if (turn === null) return turnNotFound(turnId);
  return refuse(404, {
    code: "NotFound",
    title: "Turn did not fail",
    detail: `turn ${turnId} is ${turn.state}, and only a Failed turn has a failure`,
    fix: `Read turn ${turnId}`,
  });
};

const linesOf = async (env: Env, cursor: TranscriptCursor): Promise<TranscriptLine[]> => {
  if (cursor.kind === "Lines") return cursor.lines;
  const object = await env.STORE.get(cursor.storageKey, { range: cursor.range });
  if (object === null) throw new Error(`transcript chunk ${cursor.storageKey} is indexed but missing from the store`);
  return decodeLines(await object.text());
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

const COMPACT_READ_PASSES = 8;
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
  const readAfter = (page: Page) =>
    tenantOf(env, caller).transcriptCursor(
      caller.tenantId,
      sessionId,
      page.cursor,
      query.turnId ?? null,
      compact || limit === null ? chunkLines : limit - page.lines.length,
      compact ? null : Math.max(1, maxBytes - page.bytes),
    );
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
  let read = cursor;
  for (let pass = 1; ; pass += 1) {
    const fetched = await linesOf(env, read);
    const paged = pageOf(page, fetched, compactor, limit, maxBytes);
    if (!paged.ok) {
      return refuse(422, {
        code: "TranscriptLineUnreadable",
        title: "Transcript line is not JSON",
        detail: `line ${paged.lineSeq} of session ${sessionId} is not JSON, so the transcript has no compact form from there`,
        fix: "Read the transcript without compact",
      });
    }
    page = paged.page;
    const settled = page.full || fetched.length === 0 || page.cursor >= read.lastLineSeq;
    if (settled || (compactor !== null && pass === COMPACT_READ_PASSES)) {
      const { sessionState } = read;
      const finished = !read.inFlight && page.cursor >= read.lastLineSeq;
      if (compactor === null) {
        return ok(
          TranscriptPageSchema.parse({ form: "Raw", sessionState, lines: page.lines, cursor: page.cursor, finished }),
        );
      }
      return ok({
        form: "Compact" as const,
        sessionId,
        sessionState,
        turns: byTurn(page.lines),
        cursor: page.cursor,
        finished,
      });
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
  const failures = await tenantOf(env, caller).listStopFailures(caller.tenantId, sessionId);
  return failures === null ? sessionNotFound(sessionId) : ok(failures);
};

export const listSnapshots = async (env: Env, caller: Caller, sessionId: string): Promise<Outcome<Snapshot[]>> => {
  const snapshots = await tenantOf(env, caller).listSnapshots(caller.tenantId, sessionId);
  return snapshots === null ? sessionNotFound(sessionId) : ok(snapshots);
};

export const listCredentialHandovers = async (
  env: Env,
  caller: Caller,
  sessionId: string,
): Promise<Outcome<CredentialHandover[]>> => {
  const handovers = await tenantOf(env, caller).listCredentialHandovers(caller.tenantId, sessionId);
  return handovers === null ? sessionNotFound(sessionId) : ok(handovers);
};

export const getSnapshot = async (env: Env, caller: Caller, snapshotId: string): Promise<Outcome<Snapshot>> => {
  const snapshot = await tenantOf(env, caller).getSnapshot(caller.tenantId, snapshotId);
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
  /^\/v1\/sessions\/([^/]+)(\/turns|\/transcript|\/snapshots|\/credential-handovers|\/stop-failures|\/stop|\/archive)?$/;
const SESSION_GETS = ["", "/turns", "/transcript", "/snapshots", "/credential-handovers", "/stop-failures"];
const SESSION_POSTS = ["/turns", "/stop", "/archive"];
const FROM_ISSUE_PATH = "/v1/sessions/from-issue";
const TURN_PATH = /^\/v1\/turns\/([^/]+)(\/failure)?$/;
const TURN_WAIT_PATH = "/v1/turns/wait";
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
    ((turn !== null || snapshot !== null) && request.method === "GET");
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
    const query = SessionListQuerySchema.safeParse(queryOf(url, []));
    if (!query.success) return invalidQuery("sessions.list", query.error);
    return answer(await listSessions(env, caller, query.data));
  }
  if (session?.[1] !== undefined) {
    return sessionRoute(request, url, env, caller, decodeURIComponent(session[1]), session[2]);
  }
  if (pathname === TURN_WAIT_PATH) {
    const query = TurnWaitQuerySchema.safeParse({
      ...queryOf(url, ["timeoutSeconds"]),
      turnId: url.searchParams.getAll("turnId"),
    });
    if (!query.success) return invalidQuery("turns.wait", query.error);
    return answer(await waitTurns(env, caller, query.data.turnId, query.data.timeoutSeconds));
  }
  if (turn?.[1] !== undefined) {
    const raw = decodeURIComponent(turn[1]);
    const path = TurnPathSchema.safeParse({ turnId: raw });
    if (!path.success) return answer(turnNotFound(raw));
    if (turn[2] === "/failure") return answer(await getTurnFailure(env, caller, path.data.turnId));
    return answer(await getTurn(env, caller, path.data.turnId));
  }
  return answer(await getSnapshot(env, caller, decodeURIComponent(snapshot?.[1] ?? "")));
};
