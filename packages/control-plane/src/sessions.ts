import {
  SessionListQuerySchema,
  SessionPathSchema,
  SessionStartSchema,
  TranscriptPageSchema,
  TranscriptQuerySchema,
  TurnPathSchema,
  TurnSendSchema,
} from "@tumpel/api/schemas";
import type { z } from "zod";
import { type CredentialRefusal, checkCredential } from "./dispatch-variables.ts";
import { HARNESS_CATALOG, pinnedEntry } from "./harness-catalog";
import { hostOf, listHosts, type Outcome, type Refused } from "./hosts";
import { issues, json, parseBody, problem } from "./http";
import type { Caller } from "./identity";
import type { Env } from "./index";
import type {
  Session,
  SessionFilter,
  SessionStart,
  Snapshot,
  StartedSession,
  Turn,
  TurnFailure,
} from "./tenant-sessions";
import { DEFAULT_PAGE_LINES, decodeLines } from "./transcript";

export type TranscriptPage = z.infer<typeof TranscriptPageSchema>;
export type TranscriptQuery = z.infer<typeof TranscriptQuerySchema>;
export type SessionListQuery = z.infer<typeof SessionListQuerySchema>;

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
    fix: "List your sessions with tumpel session list",
  });

const turnNotFound = (turnId: string): Refused =>
  refuse(404, {
    code: "NotFound",
    title: "No such turn",
    detail: `your tenant has no turn ${turnId}`,
    fix: "List a session's turns with tumpel turn list <sessionId>",
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
      detail: `${owner} holds no ${refusal.provider} credential, which ${harness} reads`,
      fix: `Add a ${refusal.supported.join(" or ")} for ${refusal.provider} to that secret set with tumpel config apply, then ${retry}`,
    });
  }
  if (refusal.kind === "Unsupported") {
    return refuse(422, {
      code: "CredentialKindUnsupported",
      title: "Credential kind not accepted by the harness",
      detail: `${owner} holds ${refusal.name}, a ${refusal.credentialKind}, and ${harness} accepts only ${refusal.supported.join(", ")}`,
      fix: `Replace ${refusal.name} with a ${refusal.supported.join(" or ")} with tumpel config apply, then ${retry}`,
    });
  }
  return refuse(422, {
    code: "CredentialExpired",
    title: "Subscription token expired",
    detail: `subscription token ${refusal.name} of ${owner} expired at ${refusal.expiresAt}`,
    fix: `Write a fresh token and its expiresAt with tumpel config apply --rewrite-secrets, then ${retry}`,
  });
};

const tenantOf = (env: Env, caller: Caller) => env.TENANT.getByName(caller.tenantId);

export const startSession = async (
  env: Env,
  caller: Caller,
  start: SessionStart,
  endpoint: string,
  now: number,
): Promise<Outcome<StartedSession>> => {
  const tenant = tenantOf(env, caller);
  const persona = await tenant.getPersona(caller.tenantId, start.personaId);
  if (persona === null) {
    return refuse(404, {
      code: "NotFound",
      title: "No such persona",
      detail: `your tenant owns no persona ${start.personaId}`,
      fix: "List the personas with GET /v1/personas and start with one of the ids it returns",
    });
  }
  const entry = pinnedEntry(await tenant.listPins(), persona.harness);
  if (entry === undefined) {
    return refuse(422, {
      code: "HarnessNotInCatalog",
      title: "Harness not in the catalog",
      detail: `persona ${persona.name} runs ${persona.harness}, of which the catalog has no version your tenant can run; it holds ${HARNESS_CATALOG.map((listed) => `${listed.harness} ${listed.harnessVersion}`).join(", ")}`,
      fix: "Pin a listed version of that harness, or point the persona at a harness the catalog lists, with tumpel config apply",
    });
  }
  const secretSet = await tenant.getSecretSet(caller.tenantId, persona.secretSetId);
  if (secretSet === null) {
    throw new Error(`persona ${persona.personaId} names secret set ${persona.secretSetId}, which does not exist`);
  }
  const credential = checkCredential(entry, secretSet.keys, now);
  if (credential.kind !== "Usable") {
    return credentialRefused(
      credential,
      `secret set ${secretSet.name} of persona ${persona.name}`,
      persona.harness,
      "start again",
    );
  }
  const hosts = await listHosts(env.DB, caller.tenantId);
  const host = hosts.find((candidate) => candidate.state === "Online");
  if (host === undefined) {
    return refuse(409, {
      code: "NoHostAvailable",
      title: "No host online",
      detail:
        hosts.length === 0
          ? "your tenant has no hosts"
          : `no host of your tenant is online: ${hosts.map((listed) => `${listed.name} (${listed.hostId}) is ${listed.state}`).join(", ")}`,
      fix: "Start tumpel-supervisor run on a host, or enrol one with tumpel host mint-token, then start again",
    });
  }
  const started = await tenant.startSession(
    caller.tenantId,
    {
      principalId: caller.principalId,
      hostId: host.hostId,
      harness: entry.harness,
      harnessVersion: entry.harnessVersion,
      endpoint,
      start,
    },
    now,
  );
  return ok(started);
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
  const host = await hostOf(env.DB, caller.tenantId, session.hostId);
  if (host?.state !== "Online") {
    return refuse(409, {
      code: "HostOffline",
      title: "Host offline",
      detail: `session ${sessionId} runs on host ${session.hostId}, which is ${host?.state ?? "gone"}`,
      fix: "Start tumpel-supervisor run on that host, then send the turn again",
    });
  }
  const sent = await tenant.sendTurn(caller.tenantId, sessionId, prompt, now);
  if (sent.kind === "Sent") return ok(sent.turn);
  if (sent.kind === "NotFound") return sessionNotFound(sessionId);
  if (sent.kind === "InFlight") {
    return refuse(409, {
      code: "TurnInFlight",
      title: "A turn is running",
      detail: `session ${sessionId} is still running turn ${sent.turnId}`,
      fix: `Wait for turn ${sent.turnId} to finish (tumpel transcript read ${sent.turnId} --follow), then send again`,
    });
  }
  return credentialRefused(sent.refusal, `the secret set of persona ${sent.personaId}`, session.harness, "send again");
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
    fix: `Read the turn with tumpel turn get ${turnId}`,
  });
};

export const readTranscript = async (
  env: Env,
  caller: Caller,
  sessionId: string,
  query: TranscriptQuery,
): Promise<Outcome<TranscriptPage>> => {
  const after = query.after ?? 0;
  const cursor = await tenantOf(env, caller).transcriptCursor(
    caller.tenantId,
    sessionId,
    after,
    query.turnId ?? null,
    query.limit ?? DEFAULT_PAGE_LINES,
  );
  if (cursor === null) return sessionNotFound(sessionId);
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
  return ok(
    TranscriptPageSchema.parse({
      sessionState: cursor.sessionState,
      lines,
      cursor: lines.at(-1)?.lineSeq ?? after,
    }),
  );
};

export const listSnapshots = async (env: Env, caller: Caller, sessionId: string): Promise<Outcome<Snapshot[]>> => {
  const snapshots = await tenantOf(env, caller).listSnapshots(caller.tenantId, sessionId);
  return snapshots === null ? sessionNotFound(sessionId) : ok(snapshots);
};

export const getSnapshot = async (env: Env, caller: Caller, snapshotId: string): Promise<Outcome<Snapshot>> => {
  const snapshot = await tenantOf(env, caller).getSnapshot(caller.tenantId, snapshotId);
  if (snapshot !== null) return ok(snapshot);
  return refuse(404, {
    code: "NotFound",
    title: "No such snapshot",
    detail: `your tenant has no stored snapshot ${snapshotId}`,
    fix: "List a session's snapshots with tumpel snapshot list <sessionId>",
  });
};

const queryOf = (url: URL, numeric: string[]): Record<string, unknown> =>
  Object.fromEntries(
    [...url.searchParams].map(([name, value]) => [
      name,
      numeric.includes(name) && /^\d+$/.test(value) ? Number(value) : value,
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

const SESSION_PATH = /^\/v1\/sessions\/([^/]+)(\/turns|\/transcript|\/snapshots)?$/;
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
  if (action === "/turns") return answer(await listTurns(env, caller, sessionId));
  if (action === "/snapshots") return answer(await listSnapshots(env, caller, sessionId));
  if (action === "/transcript") {
    const query = TranscriptQuerySchema.safeParse(queryOf(url, ["after", "limit"]));
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
    (pathname === "/v1/sessions" && (posting || request.method === "GET")) ||
    (session !== null && (request.method === "GET" || (posting && session[2] === "/turns"))) ||
    ((turn !== null || snapshot !== null) && request.method === "GET");
  if (!routed) return null;
  const caller = await authenticate(request, env);
  if (caller instanceof Response) return caller;
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
