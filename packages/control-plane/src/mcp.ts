import {
  ConfigApiKeySchema,
  ConfigSecretSetSchema,
  ConfigSecretVariableSchema,
  ConfigSubscriptionTokenSchema,
  DevicePathSchema,
  EnrolmentTokenMintSchema,
  HarnessPathSchema,
  HarnessPinCreateSchema,
  HostLabelsSchema,
  HostPathSchema,
  PersonaCreateSchema,
  PersonaFileUploadRequestSchema,
  PersonaPathSchema,
  PersonaUpdateSchema,
  ProblemSchema,
  SecretSetPathSchema,
  SessionListQuerySchema,
  SessionPathSchema,
  SessionStartSchema,
  SnapshotPathSchema,
  TranscriptQuerySchema,
  TurnPathSchema,
  TurnSendSchema,
} from "@tumpel/api/schemas";
import { z } from "zod";
import manifest from "../package.json";
import { issues, type Problem } from "./http";
import { MCP_PATH } from "./oauth";

const MODERN_VERSION = "2026-07-28";
const LATEST_LEGACY = "2025-11-25";
const LEGACY_VERSIONS = [LATEST_LEGACY, "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/;

const SERVER_INFO = { name: "tumpel", version: manifest.version };

const INSTRUCTIONS =
  "tumpel runs coding harness sessions on machines the user's tenant owns. Every tool calls the tumpel REST API as the signed-in principal: tumpel_whoami names the tenant, tumpel_host_* add, label and retire machines, tumpel_persona_* and tumpel_harness_* shape what runs, and tumpel_secret_set_* read key names and draft config entries, since secret values are written only by tumpel config apply on the CLI. tumpel_session_start runs a session on an online host, tumpel_turn_send sends its next prompt, tumpel_session_stop frees its box, tumpel_session_archive deletes its snapshots, and tumpel_transcript_read reads what the harness wrote, page by page: pass the cursor of the last page as after.";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;
const UNAUTHORIZED = -32001;

export type ToolResult = { ok: true; text: string } | { ok: false; error: string };

export type Dispatch = (request: Request) => Promise<Response>;

export type Authorize = () => Promise<Dispatch | Response>;

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface ToolDefinition {
  name: string;
  description: string;
  input: z.ZodObject;
  request: { method: Method; path: string } | null;
  answer: "rest" | "configSecretSet";
}

const NO_ARGUMENTS = z.object({});

const KEY_NAMES_ONLY = ConfigSecretSetSchema.extend({
  secrets: z.array(
    z.discriminatedUnion("kind", [
      ConfigSecretVariableSchema.strict(),
      ConfigApiKeySchema.strict(),
      ConfigSubscriptionTokenSchema.strict(),
    ]),
  ),
}).strict();

const KEY_NAMES_RULE =
  "Secret values never pass through MCP and this tool writes nothing: each member names its kind (Variable, ApiKey, or SubscriptionToken with its expiresAt), a provider for a credential, and only the environment variable (valueFrom.env) its value is read from, which the server cannot resolve. Returns the ConfigSecretSet entry to put in secretSets of the tenant config file; export each named variable on your machine and run tumpel config apply <file>, which writes the values.";

const rest = (name: string, method: Method, path: string, input: z.ZodObject, description: string): ToolDefinition => ({
  name,
  description,
  input,
  request: { method, path },
  answer: "rest",
});

export const TOOLS: ToolDefinition[] = [
  rest(
    "tumpel_whoami",
    "GET",
    "/v1/whoami",
    NO_ARGUMENTS,
    "Name the tenant and principal this connector acts as. Returns the Whoami of GET /v1/whoami: {tenant, principal}.",
  ),
  rest(
    "tumpel_devices_list",
    "GET",
    "/v1/devices",
    NO_ARGUMENTS,
    "List the devices signed in as you. Returns the Device[] of GET /v1/devices.",
  ),
  rest(
    "tumpel_devices_revoke",
    "DELETE",
    "/v1/devices/{deviceId}",
    DevicePathSchema,
    "Sign a device out; its token stops working at once. Calls DELETE /v1/devices/{deviceId}.",
  ),
  rest(
    "tumpel_host_mint_token",
    "POST",
    "/v1/enrolment-tokens",
    EnrolmentTokenMintSchema,
    "Mint a one-time enrolment token for a new host; expiresInSeconds is how long the token enrols a host. Returns the MintedEnrolmentToken of POST /v1/enrolment-tokens: {enrolmentToken, token, installCommand}. The token is shown once; save it in the file the install command names, on the host.",
  ),
  rest(
    "tumpel_host_list",
    "GET",
    "/v1/hosts",
    NO_ARGUMENTS,
    "List the tenant's hosts with their presence. Returns the Host[] of GET /v1/hosts; state is Enrolled, Online, Offline or Revoked.",
  ),
  rest(
    "tumpel_host_get",
    "GET",
    "/v1/hosts/{hostId}",
    HostPathSchema,
    "Read one host with its presence and labels. Returns the Host of GET /v1/hosts/{hostId}.",
  ),
  rest(
    "tumpel_host_revoke",
    "POST",
    "/v1/hosts/{hostId}/revoke",
    HostPathSchema,
    "Revoke a host: its channel closes and it cannot connect again. Returns the Host of POST /v1/hosts/{hostId}/revoke.",
  ),
  rest(
    "tumpel_host_set_labels",
    "PUT",
    "/v1/hosts/{hostId}/labels",
    HostPathSchema.extend(HostLabelsSchema.shape),
    "Replace every label of a host. Returns the Host of PUT /v1/hosts/{hostId}/labels.",
  ),
  rest(
    "tumpel_harness_list",
    "GET",
    "/v1/harnesses",
    NO_ARGUMENTS,
    "List the harness catalog: every harness and version a tenant can pin. Returns the HarnessCatalogEntry[] of GET /v1/harnesses.",
  ),
  rest(
    "tumpel_harness_list_pins",
    "GET",
    "/v1/harnesses/pins",
    NO_ARGUMENTS,
    "List the tenant's harness pins. Returns the HarnessPin[] of GET /v1/harnesses/pins.",
  ),
  rest(
    "tumpel_harness_pin",
    "PUT",
    "/v1/harnesses/pins",
    HarnessPinCreateSchema,
    "Pin a harness to a version of the catalog, replacing its pin. Returns the HarnessPin of PUT /v1/harnesses/pins.",
  ),
  rest(
    "tumpel_harness_unpin",
    "DELETE",
    "/v1/harnesses/pins/{harness}",
    HarnessPathSchema,
    "Remove the tenant's pin for a harness. Calls DELETE /v1/harnesses/pins/{harness}.",
  ),
  rest(
    "tumpel_persona_create",
    "POST",
    "/v1/personas",
    PersonaCreateSchema,
    "Create a persona: the harness its sessions run, the secretSetId of the secret set they run on, and the harness's own config files at paths the harness catalog accepts, each Inline (base64 content, up to PersonaFileLimit.InlineFileBytes) or Stored (digest and sizeBytes of an uploaded file). Returns the Persona of POST /v1/personas.",
  ),
  rest(
    "tumpel_persona_upload_file",
    "POST",
    "/v1/personas/file-uploads",
    PersonaFileUploadRequestSchema,
    "Presign the upload of one persona file larger than PersonaFileLimit.InlineFileBytes, named by the sha256 digest and size of its bytes. Returns the PersonaFileUpload of POST /v1/personas/file-uploads: PUT the bytes to uploadUrl before uploadExpiresAt, then name the file as Stored by digest in a persona write.",
  ),
  rest(
    "tumpel_persona_list",
    "GET",
    "/v1/personas",
    NO_ARGUMENTS,
    "List the tenant's personas. Returns the Persona[] of GET /v1/personas.",
  ),
  rest(
    "tumpel_persona_get",
    "GET",
    "/v1/personas/{personaId}",
    PersonaPathSchema,
    "Read one persona. Returns the Persona of GET /v1/personas/{personaId}.",
  ),
  rest(
    "tumpel_persona_update",
    "PUT",
    "/v1/personas/{personaId}",
    PersonaPathSchema.extend(PersonaUpdateSchema.shape),
    "Replace a persona's name, secret set and whole file set; its harness is fixed at create and a file left out is deleted. Name an unchanged file as Stored by its digest and sizeBytes. Returns the Persona of PUT /v1/personas/{personaId}.",
  ),
  rest(
    "tumpel_persona_delete",
    "DELETE",
    "/v1/personas/{personaId}",
    PersonaPathSchema,
    "Delete a persona no session ran on; one that sessions ran on is refused. Calls DELETE /v1/personas/{personaId}.",
  ),
  {
    name: "tumpel_secret_set_create",
    description: `Draft a new secret set of variables and provider credentials, by member name. ${KEY_NAMES_RULE}`,
    input: KEY_NAMES_ONLY,
    request: null,
    answer: "configSecretSet",
  },
  rest(
    "tumpel_secret_set_list",
    "GET",
    "/v1/secret-sets",
    NO_ARGUMENTS,
    "List the tenant's secret sets with their member names and kinds; values are write-only and never returned. Returns the SecretSet[] of GET /v1/secret-sets.",
  ),
  rest(
    "tumpel_secret_set_get",
    "GET",
    "/v1/secret-sets/{secretSetId}",
    SecretSetPathSchema,
    "Read one secret set with its member names and kinds; values are write-only and never returned. Returns the SecretSet of GET /v1/secret-sets/{secretSetId}.",
  ),
  {
    name: "tumpel_secret_set_update",
    description: `Draft the replacement of an existing secret set's name and members, by member name; the set must exist. ${KEY_NAMES_RULE}`,
    input: SecretSetPathSchema.extend(KEY_NAMES_ONLY.shape).strict(),
    request: { method: "GET", path: "/v1/secret-sets/{secretSetId}" },
    answer: "configSecretSet",
  },
  rest(
    "tumpel_secret_set_delete",
    "DELETE",
    "/v1/secret-sets/{secretSetId}",
    SecretSetPathSchema,
    "Delete a secret set and its stored values; refused while a persona names it. Calls DELETE /v1/secret-sets/{secretSetId}.",
  ),
  rest(
    "tumpel_session_start",
    "POST",
    "/v1/sessions",
    SessionStartSchema,
    "Start a session on an online host of the tenant with its first prompt; it runs its persona's harness at the pinned version, with the persona's files and secret set. Returns the StartedSession of POST /v1/sessions: {session, turn}, before the harness writes anything.",
  ),
  rest(
    "tumpel_session_list",
    "GET",
    "/v1/sessions",
    SessionListQuerySchema,
    "List the tenant's sessions, optionally only those in one state or on one host. Returns the Session[] of GET /v1/sessions.",
  ),
  rest(
    "tumpel_session_get",
    "GET",
    "/v1/sessions/{sessionId}",
    SessionPathSchema,
    "Read one session. Returns the Session of GET /v1/sessions/{sessionId}; state is Starting, Idle, Running, Stopping, Stopped or Archived.",
  ),
  rest(
    "tumpel_session_stop",
    "POST",
    "/v1/sessions/{sessionId}/stop",
    SessionPathSchema,
    "Stop a session with no turn running: its host snapshots it and frees its box, and the next tumpel_turn_send boots a fresh box from the snapshots. Returns the Session of POST /v1/sessions/{sessionId}/stop, Stopping until the box is gone and then Stopped; refused while a turn runs or the host is offline.",
  ),
  rest(
    "tumpel_session_archive",
    "POST",
    "/v1/sessions/{sessionId}/archive",
    SessionPathSchema,
    "Archive a Stopped session: delete its snapshots, keep its transcript readable and refuse every later send. Final. Returns the Archived Session of POST /v1/sessions/{sessionId}/archive.",
  ),
  rest(
    "tumpel_turn_send",
    "POST",
    "/v1/sessions/{sessionId}/turns",
    SessionPathSchema.extend(TurnSendSchema.shape),
    "Send a session its next prompt. Returns the Turn of POST /v1/sessions/{sessionId}/turns before any output; refused while another turn of the session runs.",
  ),
  rest(
    "tumpel_turn_list",
    "GET",
    "/v1/sessions/{sessionId}/turns",
    SessionPathSchema,
    "List a session's turns, oldest first. Returns the Turn[] of GET /v1/sessions/{sessionId}/turns.",
  ),
  rest(
    "tumpel_turn_get",
    "GET",
    "/v1/turns/{turnId}",
    TurnPathSchema,
    "Read one turn. Returns the Turn of GET /v1/turns/{turnId}; state is Offered, Running, Completed or Failed.",
  ),
  rest(
    "tumpel_turn_failure",
    "GET",
    "/v1/turns/{turnId}/failure",
    TurnPathSchema,
    "Read why a Failed turn failed. Returns the TurnFailure of GET /v1/turns/{turnId}/failure: {reason, detail}.",
  ),
  rest(
    "tumpel_transcript_read",
    "GET",
    "/v1/sessions/{sessionId}/transcript",
    SessionPathSchema.extend(TranscriptQuerySchema.shape),
    "Read a page of a session's harness-native JSONL transcript; turnId keeps one turn's lines. Pass the cursor of the previous page as after to read on; an empty page means nothing new. Returns the TranscriptPage of GET /v1/sessions/{sessionId}/transcript: {sessionState, lines, cursor}.",
  ),
  rest(
    "tumpel_snapshot_list",
    "GET",
    "/v1/sessions/{sessionId}/snapshots",
    SessionPathSchema,
    "List a session's snapshots in order, each stored or failed with its reason. Returns the Snapshot[] of GET /v1/sessions/{sessionId}/snapshots.",
  ),
  rest(
    "tumpel_snapshot_get",
    "GET",
    "/v1/snapshots/{snapshotId}",
    SnapshotPathSchema,
    "Read one snapshot: its stored size, or why it was not stored. Returns the Snapshot of GET /v1/snapshots/{snapshotId}.",
  ),
];

const PATH_KEY = /\{(\w+)\}/g;

const pathKeys = (path: string): string[] => [...path.matchAll(PATH_KEY)].map((match) => match[1] ?? "");

const toolRequest = (
  tool: ToolDefinition,
  request: { method: Method; path: string },
  args: Record<string, unknown>,
  origin: string,
): Request => {
  const keys = pathKeys(request.path);
  const path = request.path.replace(PATH_KEY, (_, key: string) => encodeURIComponent(String(args[key])));
  const carriesBody = tool.answer === "rest" && (request.method === "POST" || request.method === "PUT");
  const body = Object.fromEntries(Object.entries(args).filter(([key]) => !keys.includes(key)));
  const query =
    request.method === "GET" && Object.keys(body).length > 0
      ? `?${new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]))}`
      : "";
  return new Request(`${origin}${path}${query}`, {
    method: request.method,
    headers: { "content-type": "application/json" },
    ...(carriesBody ? { body: JSON.stringify(body) } : {}),
  });
};

const refusalText = async (answer: Response): Promise<string> => {
  const problem = ProblemSchema.safeParse(await answer.json().catch(() => null));
  if (!problem.success) return `the control plane answered ${answer.status} without a problem document`;
  return `${problem.data.title}: ${problem.data.detail}. ${problem.data.fix}`;
};

const runTool = async (
  tool: ToolDefinition,
  args: Record<string, unknown>,
  dispatch: Dispatch,
  origin: string,
): Promise<ToolResult> => {
  if (tool.request !== null) {
    const answer = await dispatch(toolRequest(tool, tool.request, args, origin));
    if (!answer.ok) return { ok: false, error: await refusalText(answer) };
    if (tool.answer === "rest") {
      const text = answer.status === 204 ? "" : await answer.text();
      return { ok: true, text: text || `${tool.request.method} ${tool.request.path} answered ${answer.status}` };
    }
  }
  const entry = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "secretSetId"));
  return { ok: true, text: JSON.stringify(ConfigSecretSetSchema.parse(entry)) };
};

interface Bound {
  dispatch: Dispatch;
  origin: string;
}

type Id = string | number | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const reply = (id: Id, result: unknown, status = 200): Response =>
  Response.json({ jsonrpc: "2.0", id, result }, { status, headers: { "cache-control": "no-store" } });

const refuse = (id: Id, code: number, message: string, status: number, data?: unknown): Response =>
  Response.json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    { status, headers: { "cache-control": "no-store" } },
  );

export const mcpRefusal = (status: number, body: Problem, headers: Record<string, string> = {}): Response => {
  const problem = ProblemSchema.parse(body);
  const answer = refuse(null, UNAUTHORIZED, `${problem.detail}; ${problem.fix}`, status, problem);
  for (const [name, value] of Object.entries(headers)) answer.headers.set(name, value);
  return answer;
};

const takesEventStream = (request: Request): boolean => {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/event-stream") && !accept.includes("application/json") && !accept.includes("*/*");
};

const CARRIED_HEADERS = ["www-authenticate", "access-control-allow-origin", "vary"];

const asEventStream = async (answer: Response): Promise<Response> => {
  if (answer.body === null) return answer;
  const headers = new Headers({
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  for (const name of CARRIED_HEADERS) {
    const value = answer.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(`event: message\ndata: ${await answer.text()}\n\n`, { status: answer.status, headers });
};

const decodeHeader = (value: string): string => {
  const sentinel = BASE64_SENTINEL.exec(value);
  if (!sentinel?.[1]) return value;
  return new TextDecoder().decode(Uint8Array.from(atob(sentinel[1]), (char) => char.charCodeAt(0)));
};

const unsupportedVersion = (id: Id, requested: string): Response =>
  refuse(id, UNSUPPORTED_VERSION, "Unsupported protocol version", 400, { supported: SUPPORTED_VERSIONS, requested });

const toolNamed = (name: unknown): ToolDefinition | undefined =>
  typeof name === "string" ? TOOLS.find((tool) => tool.name === name) : undefined;

const listResult = (): unknown => ({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input),
  })),
});

const callResult = async (id: Id, params: unknown, run: Bound): Promise<Response> => {
  if (!isRecord(params)) return refuse(id, INVALID_PARAMS, "tools/call takes {name, arguments}", 200);
  const tool = toolNamed(params.name);
  if (tool === undefined) return refuse(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`, 200);
  const args = params.arguments;
  if (args !== undefined && !isRecord(args)) {
    return refuse(id, INVALID_PARAMS, `${tool.name} takes its arguments as a JSON object`, 200);
  }
  const parsed = tool.input.safeParse(args ?? {});
  const outcome: ToolResult = parsed.success
    ? await runTool(tool, parsed.data, run.dispatch, run.origin)
    : { ok: false, error: `${tool.name} refused its arguments: ${issues(parsed.error)}` };
  const text = outcome.ok ? outcome.text : outcome.error;
  return reply(id, { content: [{ type: "text", text }], ...(outcome.ok ? {} : { isError: true }) });
};

const initializeResult = (params: unknown): unknown => {
  const wanted = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  return {
    protocolVersion: LEGACY_VERSIONS.includes(wanted) ? wanted : LATEST_LEGACY,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
};

const discoverResult = (): unknown => ({
  resultType: "complete",
  supportedVersions: SUPPORTED_VERSIONS,
  capabilities: { tools: {} },
  _meta: { [META_SERVER_INFO]: SERVER_INFO },
  instructions: INSTRUCTIONS,
});

const declaredVersion = (params: unknown): string | null => {
  if (!isRecord(params) || !isRecord(params._meta)) return null;
  const version = params._meta[META_VERSION];
  return typeof version === "string" ? version : null;
};

const headerMismatch = (request: Request, method: string, params: unknown, declared: string): string | null => {
  const header = (name: string): string | null => request.headers.get(name);
  const version = header("mcp-protocol-version");
  if (version === null) return "MCP-Protocol-Version is missing";
  if (version !== declared) {
    return `MCP-Protocol-Version header value '${version}' does not match the _meta value '${declared}'`;
  }
  const named = header("mcp-method");
  if (named === null) return "Mcp-Method is missing";
  if (named !== method) return `Mcp-Method header value '${named}' does not match body value '${method}'`;
  if (method !== "tools/call") return null;
  const name = isRecord(params) && typeof params.name === "string" ? params.name : "";
  const carried = header("mcp-name");
  if (carried === null) return "Mcp-Name is missing";
  if (decodeHeader(carried) !== name) return `Mcp-Name header value '${carried}' does not match body value '${name}'`;
  return null;
};

const modern = async (
  request: Request,
  id: Id,
  method: string,
  params: unknown,
  declared: string,
  run: Bound,
): Promise<Response> => {
  if (declared !== MODERN_VERSION) return unsupportedVersion(id, declared);
  const mismatch = headerMismatch(request, method, params, declared);
  if (mismatch !== null) return refuse(id, HEADER_MISMATCH, `Header mismatch: ${mismatch}`, 400);
  if (method === "server/discover") return reply(id, discoverResult());
  if (method === "tools/list") return reply(id, listResult());
  if (method === "tools/call") return callResult(id, params, run);
  return refuse(id, METHOD_NOT_FOUND, `Method not found: ${method}`, 404);
};

const legacy = async (request: Request, id: Id, method: string, params: unknown, run: Bound): Promise<Response> => {
  const version = request.headers.get("mcp-protocol-version");
  if (method !== "initialize" && version !== null && !LEGACY_VERSIONS.includes(version)) {
    return unsupportedVersion(id, version);
  }
  if (method === "initialize") return reply(id, initializeResult(params));
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, listResult());
  if (method === "tools/call") return callResult(id, params, run);
  return refuse(id, METHOD_NOT_FOUND, `Method not found: ${method}`, 404);
};

const answer = async (request: Request, authorize: Authorize): Promise<Response> => {
  const dispatch = await authorize();
  if (dispatch instanceof Response) return dispatch;
  const run: Bound = { dispatch, origin: new URL(request.url).origin };
  const body: unknown = await request.json().catch(() => null);
  if (body === null) return refuse(null, PARSE_ERROR, "the request body is not JSON", 400);
  if (Array.isArray(body)) {
    return refuse(null, INVALID_REQUEST, "this endpoint takes one JSON-RPC message per request", 400);
  }
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return refuse(null, INVALID_REQUEST, 'a message must be {"jsonrpc": "2.0", "method": ...}', 400);
  }
  const { method, params, id } = body;
  if (id === undefined || id === null) return new Response(null, { status: 202 });
  if (typeof id !== "string" && typeof id !== "number") {
    return refuse(null, INVALID_REQUEST, "a message id is a string or a number", 400);
  }
  const declared = declaredVersion(params);
  return declared === null
    ? legacy(request, id, method, params, run)
    : modern(request, id, method, params, declared, run);
};

export const mcpEndpoint = async (request: Request, authorize: Authorize): Promise<Response> => {
  if (request.method !== "POST") {
    return refuse(
      null,
      INVALID_REQUEST,
      `${MCP_PATH} answers a POST; it opens no stream of its own and keeps no session`,
      405,
    );
  }
  const answered = await answer(request, authorize);
  return takesEventStream(request) ? asEventStream(answered) : answered;
};
