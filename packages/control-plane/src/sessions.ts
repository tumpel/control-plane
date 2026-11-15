import {
  SessionListQuerySchema,
  SessionPathSchema,
  SessionStartFromIssueSchema,
  SessionStartSchema,
  TranscriptPageSchema,
  TranscriptQuerySchema,
  TurnPathSchema,
  TurnSendSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { type CredentialRefusal, checkCredential } from "./dispatch-variables.ts";
import { githubRepository, notARepository, readIssue, repositoryUrl } from "./github.ts";
import { HARNESS_CATALOG, pinnedEntry } from "./harness-catalog";
import { type Host, hostOf, listHosts, type Outcome, type Refused } from "./hosts";
import { issues, json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import type { Unplaceable } from "./placement";
import { unreadableSecretSet } from "./secret-members.ts";
import { settingsOf } from "./settings";
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
  Turn,
  TurnFailure,
} from "./tenant-sessions";
import { ticketBranch, ticketPrompt } from "./ticket-prompt.ts";
import { compactorOf, DEFAULT_PAGE_BYTES, decodeLines, pageOf } from "./transcript";

export type TranscriptPage = z.infer<typeof TranscriptPageSchema>;
export type TranscriptQuery = z.infer<typeof TranscriptQuerySchema>;
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;
export type SessionStartFromIssue = z.infer<typeof SessionStartFromIssueSchema>;

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
    detail: `session ${session.sessionId} runs on host ${host === null ? session.hostId : `${host.name} (${host.hostId})`}, which is ${host?.state ?? "gone"}`,
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

export const credentialRefused = (
  refusal: CredentialRefusal,
  owner: string,
  harness: string,
  retry: string,
): Refused => {
  if (refusal.kind === "NoCredential") {
    return refuse(422, {
      code: "NoCredential",
      title: "No provider credential",
      detail: `${owner} holds no credential ${harness} reads: ${refusal.accepted.map(({ kind, provider }) => `a ${kind} for ${provider}`).join(", or ")}`,
      fix: `Add one of those to that secret set, then ${retry}`,
    });
  }
  if (refusal.kind === "Unsupported") {
    return refuse(422, {
      code: "CredentialKindUnsupported",
      title: "Credential kind not accepted by the harness",
      detail: `${owner} holds ${refusal.name}, a ${refusal.credentialKind}, and ${harness} accepts only ${refusal.supported.join(", ")}`,
      fix: `Replace ${refusal.name} with a ${refusal.supported.join(" or ")} in that secret set, then ${retry}`,
    });
  }
  return refuse(422, {
    code: "CredentialExpired",
    title: "Subscription token expired",
    detail: `subscription token ${refusal.name} of ${owner} expired at ${refusal.expiresAt}`,
    fix: `Write a fresh token and its expiresAt to that secret set, then ${retry}`,
  });
};

export const why = (refused: Unplaceable): string => {
  const named = `${refused.host.name} (${refused.host.hostId})`;
  if (refused.reason === "NotOnline") return `${named} is ${refused.host.state}`;
  if (refused.reason === "NoImage") {
    const { harness, harnessVersion, architectures } = refused.image;
    const carried =
      architectures.length === 0
        ? `no ${harness} ${harnessVersion} guest image`
        : `${harness} ${harnessVersion} guest images for ${architectures.join(", ")} only`;
    return `${named} is ${refused.host.architecture}, and the current release carries ${carried}`;
  }
  return `${named} runs a turn in all ${refused.usage.boxCapacity} of its box slots`;
};

export const placeableFix = (hosts: Unplaceable[], retry: string): string => {
  const [lacking] = hosts.flatMap((each) => (each.reason === "NoImage" ? [each.image] : []));
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

const stranded = (session: Session, hosts: Host[], missingTurnIds: string[]): Refused => {
  const host = hosts.find((listed) => listed.hostId === session.hostId);
  if (host === undefined) {
    throw new Error(`session ${session.sessionId} runs on host ${session.hostId}, which its tenant does not list`);
  }
  return refuse(409, {
    code: "HostOffline",
    title: "Host offline",
    detail: `session ${session.sessionId} runs on host ${host.name} (${host.hostId}), which is ${host.state}, and its snapshots miss completed turns ${missingTurnIds.join(", ")}, so it cannot move to another host`,
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
  const persona = await tenant.getPersona(caller.tenantId, start.personaId);
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
  const credential = checkCredential(entry, secretSet.keys, now);
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

const placed = <T>(started: Started<T>): Outcome<T> =>
  started.kind === "Unplaced" ? unplaced(started.hosts, "start again") : ok(started.started);

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
  if ((await tenant.getPersona(caller.tenantId, start.personaId)) === null) return personaNotFound(start.personaId);
  const token = await tenant.repositoryReadToken(caller.tenantId, start.personaId, target, now);
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
  return ok(await tenantOf(env, caller).listSessions(caller.tenantId, filter));
};

export const sendTurn = async (
  env: Env,
  caller: Caller,
  sessionId: string,
  prompt: string,
  now: number,
): Promise<Outcome<Turn>> => {
  const tenant = tenantOf(env, caller);
  const session = await tenant.getSession(caller.tenantId, sessionId);
  if (session === null) return sessionNotFound(sessionId);
  if (session.state === "Archived") return sessionArchived(sessionId, "turns");
  const hosts = await listHosts(env.DB, caller.tenantId);
  const sent = await tenant.sendTurn(caller.tenantId, sessionId, prompt, hosts, now);
  if (sent.kind === "Sent") return ok(sent.turn);
  if (sent.kind === "Stranded") return stranded(session, hosts, sent.missingTurnIds);
  if (sent.kind === "Unplaced") return unplaced(sent.hosts, "send the turn again");
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
  if (sent.kind === "PersonaGone") {
    return refuse(409, {
      code: "Conflict",
      title: "Persona deleted",
      detail: `session ${sessionId} ran on persona ${sent.personaId}, which was deleted, so it takes no more turns`,
      fix: "Start a new session with another persona",
    });
  }
  return credentialRefused(sent.refusal, `the secret set of persona ${sent.personaId}`, session.harness, "send again");
};

export const stopSession = async (
  env: Env,
  caller: Caller,
  sessionId: string,
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
  const stopped = await tenant.stopSession(caller.tenantId, sessionId, now);
  if (stopped.kind === "Stopping") return ok(stopped.session);
  if (stopped.kind === "NotFound") return sessionNotFound(sessionId);
  if (stopped.kind === "Archived") return sessionArchived(sessionId, "stop");
  return refuse(409, {
    code: "TurnInFlight",
    title: "A turn is running",
    detail: `session ${sessionId} is still running turn ${stopped.turnId}, and a stop waits for no turn`,
    fix: `Wait for turn ${stopped.turnId} to finish, then stop again`,
  });
};

export const archiveSession = async (
  env: Env,
  caller: Caller,
  sessionId: string,
  now: number,
): Promise<Outcome<Session>> => {
  const archived = await tenantOf(env, caller).archiveSession(caller.tenantId, sessionId, now);
  if (archived.kind === "Archived") return ok(archived.session);
  if (archived.kind === "NotFound") return sessionNotFound(sessionId);
  return refuse(409, {
    code: "SessionNotStopped",
    title: "Session not stopped",
    detail: `session ${sessionId} is ${archived.state}, and only a Stopped or Failed session can be archived`,
    fix: `Stop session ${sessionId}, wait until it reads Stopped, then archive again`,
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

export const readTranscript = async (
  env: Env,
  caller: Caller,
  sessionId: string,
  query: TranscriptQuery,
): Promise<Outcome<TranscriptPage>> => {
  const after = query.after ?? 0;
  const compact = query.compact ?? false;
  const maxBytes = query.maxBytes ?? DEFAULT_PAGE_BYTES;
  const cursor = await tenantOf(env, caller).transcriptCursor(
    caller.tenantId,
    sessionId,
    after,
    query.turnId ?? null,
    query.limit ?? settingsOf(env).transcriptChunkLines,
    compact ? null : maxBytes,
  );
  if (cursor === null) return sessionNotFound(sessionId);
  const compactor = compact ? compactorOf(cursor.harness) : null;
  if (compact && compactor === null) {
    return refuse(422, {
      code: "InvalidRequest",
      title: "No compact form for the harness",
      detail: `session ${sessionId} runs ${cursor.harness}, whose transcript has no compact form; only Claude Code has one`,
      fix: "Read the transcript without compact",
    });
  }
  const lines =
    cursor.kind === "Lines"
      ? cursor.lines
      : await (async () => {
          const object = await env.STORE.get(cursor.storageKey, { range: cursor.range });
          if (object === null) {
            throw new Error(`transcript chunk ${cursor.storageKey} is indexed but missing from the store`);
          }
          return decodeLines(await object.text());
        })();
  const page = pageOf(lines, after, compactor, maxBytes);
  return ok(
    TranscriptPageSchema.parse({
      sessionState: cursor.sessionState,
      lines: page.lines,
      cursor: page.cursor,
      finished: !cursor.inFlight && page.cursor >= cursor.lastLineSeq,
    }),
  );
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
    fix: "Send query parameters that match the operation's schema in packages/api",
  });

const answer = <T>(outcome: Outcome<T>): Response =>
  outcome.ok ? json(outcome.value) : problem(outcome.status, outcome.problem);

const SESSION_PATH =
  /^\/v1\/sessions\/([^/]+)(\/turns|\/transcript|\/snapshots|\/credential-handovers|\/stop-failures|\/stop|\/archive)?$/;
const SESSION_GETS = ["", "/turns", "/transcript", "/snapshots", "/credential-handovers", "/stop-failures"];
const SESSION_POSTS = ["/turns", "/stop", "/archive"];
const FROM_ISSUE_PATH = "/v1/sessions/from-issue";
const TURN_PATH = /^\/v1\/turns\/([^/]+)(\/failure)?$/;
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
    return answer(await sendTurn(env, caller, sessionId, body.value.prompt, Date.now()));
  }
  if (action === "/stop") return answer(await stopSession(env, caller, sessionId, Date.now()));
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
  if (turn?.[1] !== undefined) {
    const raw = decodeURIComponent(turn[1]);
    const path = TurnPathSchema.safeParse({ turnId: raw });
    if (!path.success) return answer(turnNotFound(raw));
    if (turn[2] === "/failure") return answer(await getTurnFailure(env, caller, path.data.turnId));
    return answer(await getTurn(env, caller, path.data.turnId));
  }
  return answer(await getSnapshot(env, caller, decodeURIComponent(snapshot?.[1] ?? "")));
};
