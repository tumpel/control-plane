import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ChannelProtocol,
  CredentialHandoverSchema,
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  HostSchema,
  MintedEnrolmentTokenSchema,
  OAuthClientSchema,
  OAuthTokenSchema,
  PersonaSchema,
  ProblemSchema,
  ReportedHostUsageSchema,
  SecretSetSchema,
  SessionSchema,
  SnapshotSchema,
  StartedSessionSchema,
  StopFailureSchema,
  SupervisorHostKeySchema,
  TranscriptPageSchema,
  TurnFailureSchema,
  TurnSchema,
} from "@tumpel/api/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import type { z } from "zod";
import { ControlEnvelopeSchema, helloBytes } from "../src/channel/protocol.ts";

const AUDIENCE = "tumpel-sessions-e2e";
const KID = "sessions-e2e-key";
const EMAIL = "sessions@example.test";
const CALLBACK = "https://client.example.test/callback";
const PROVIDER_KEY = "sk-sessions-e2e-provider-key";
const CLAIM_BUDGET_SECONDS = 3;
const CLONE_SECONDS = 2;
const FIRST_LINE_BUDGET_SECONDS = 10;
const R2_STUB_ORIGIN = "https://r2.example.test";
const HOST_OFFLINE_GRACE_MS = 30_000;
const USAGE = { boxesWarm: 0, loadAverage: 0.25, memoryAvailableMib: 6144 };
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SUPERVISOR = join(ROOT, "target", "debug", "tumpel-supervisor");
const SETTINGS = {
  dispatchGrantTtlSeconds: 300,
  snapshotDelaySeconds: 1,
  snapshotDeadlineSeconds: 60,
  turnClaimBudgetSeconds: CLAIM_BUDGET_SECONDS,
  turnFirstLineBudgetSeconds: FIRST_LINE_BUDGET_SECONDS,
  turnTotalBudgetSeconds: 60,
  transcriptChunkLines: 2,
};

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

type ControlEnvelope = z.infer<typeof ControlEnvelopeSchema>;
type ControlMessage = Extract<ControlEnvelope, { type: "Frame" }>["message"];
type HostMessage = { type: string } & Record<string, unknown>;
type Store = { put(key: string, value: string): Promise<unknown>; head(key: string): Promise<unknown> };

let certs: Server;
let server: TestHarness;
let origin: string;
let issuer: string;
let scratch: string;
let bearer: Record<string, string>;
let mcpToken: string;
let host: HostSide;
let hostId: string;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const assertion = (): string => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], email: EMAIL, iat: now, nbf: now, exp: now + 600 });
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`;
};

const browser = (): Record<string, string> => ({ "cf-access-jwt-assertion": assertion(), origin });

const call = (path: string, init: NonNullable<Parameters<TestHarness["fetch"]>[1]> = {}) =>
  server.fetch(`${origin}${path}`, { redirect: "manual", ...init });

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const refused = async (path: string, init: NonNullable<Parameters<TestHarness["fetch"]>[1]> = {}) => {
  const response = await call(path, { method: "POST", ...init, headers: { ...bearer, ...init.headers } });
  assert.equal(response.status, 409, `${path}: ${await response.clone().text()}`);
  return ProblemSchema.parse(await response.json());
};

const getJson = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
  const response = await call(path, { headers: bearer });
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
  return schema.parse(await response.json());
};

let mcpId = 0;

const tool = async <T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
  mcpId += 1;
  const response = await postJson(
    "/mcp",
    { jsonrpc: "2.0", id: mcpId, method: "tools/call", params: { name, arguments: args } },
    { authorization: `Bearer ${mcpToken}` },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const text = body.result.content[0]?.text ?? "";
  assert.equal(body.result.isError, undefined, `${name} failed: ${text}`);
  assert.equal(text.includes(PROVIDER_KEY), false, `${name} answered with the provider key`);
  return schema.parse(JSON.parse(text));
};

const eventually = async <T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  withinMs = 20_000,
): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > withinMs)
      assert.fail(`${what} did not happen within ${withinMs / 1000} s; last read ${JSON.stringify(value)}`);
    await sleep(100);
  }
};

type Counters = { received: number; sent: number };

class HostSide {
  private received: number;
  private sent: number;
  private readonly inbox: ControlMessage[] = [];
  private readonly waiters: (() => void)[] = [];
  private readonly heartbeat: NodeJS.Timeout;

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket, counters: Counters) {
    this.socket = socket;
    this.received = counters.received;
    this.sent = counters.sent;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    this.heartbeat = setInterval(() => this.beat(), 10_000);
  }

  private beat(): void {
    this.raw({ type: "Heartbeat", sentAt: new Date().toISOString(), usage: USAGE });
  }

  static async connect(
    id: string,
    key: KeyObject,
    boxCapacity = 8,
    counters: Counters = { received: 0, sent: 0 },
  ): Promise<HostSide> {
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/v1/hosts/${id}/channel`);
    const challenge = await new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
      socket.addEventListener("error", () => reject(new Error("the host channel did not open")), { once: true });
    });
    const parsed = ControlEnvelopeSchema.parse(JSON.parse(challenge));
    assert.equal(parsed.type, "Challenge");
    const side = new HostSide(socket, counters);
    side.raw({
      type: "Hello",
      hostId: id,
      protocolVersion: ChannelProtocol.Version,
      supervisorVersion: "0.1.0",
      signature: sign(null, helloBytes(parsed.nonce, id), key).toString("base64"),
      boxCapacity,
      usage: USAGE,
    });
    return side;
  }

  private raw(envelope: unknown): void {
    this.socket.send(JSON.stringify(envelope));
  }

  private receive(text: string): void {
    const envelope = ControlEnvelopeSchema.parse(JSON.parse(text));
    if (envelope.type !== "Frame" || envelope.seq <= this.received) return;
    assert.equal(envelope.seq, this.received + 1, "the control plane skipped a frame");
    this.received = envelope.seq;
    this.inbox.push(envelope.message);
    for (const wake of this.waiters.splice(0)) wake();
  }

  send(message: HostMessage): void {
    this.sent += 1;
    this.raw({ type: "Frame", seq: this.sent, ack: this.received, message });
  }

  async next<K extends ControlMessage["type"]>(type: K): Promise<Extract<ControlMessage, { type: K }>> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const at = this.inbox.findIndex((message) => message.type === type);
      if (at !== -1) return this.inbox.splice(at, 1)[0] as Extract<ControlMessage, { type: K }>;
      const left = deadline - Date.now();
      if (left <= 0) assert.fail(`no ${type} reached the host within 20 s`);
      await Promise.race([new Promise<void>((resolve) => this.waiters.push(resolve)), sleep(left)]);
    }
  }

  snapshotRequestsFor(sessionId: string): number {
    return this.inbox.filter((message) => message.type === "SnapshotRequest" && message.sessionId === sessionId).length;
  }

  counters(): Counters {
    return { received: this.received, sent: this.sent };
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.socket.close();
  }
}

const deviceToken = async (): Promise<string> => {
  const started = DeviceAuthorizationSchema.parse(
    await (await postJson("/v1/device/code", { device_name: "sessions e2e" })).json(),
  );
  assert.equal((await postJson("/v1/device/approve", { userCode: started.user_code }, browser())).status, 200);
  await sleep(started.interval * 1000 + 100);
  const granted = await postJson("/v1/device/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: started.device_code,
  });
  assert.equal(granted.status, 200);
  return DeviceTokenSchema.parse(await granted.json()).access_token;
};

const connectorToken = async (): Promise<string> => {
  const registered = await postJson("/oauth/register", { redirect_uris: [CALLBACK], client_name: "sessions e2e" });
  const client = OAuthClientSchema.parse(await registered.json());
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    state: "sessions",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const consent = new URL((await call(`/oauth/authorize?${authorize}`)).headers.get("location") ?? "");
  const csrf = randomBytes(32).toString("base64url");
  const approved = await call(consent.pathname, {
    method: "POST",
    headers: {
      ...browser(),
      "content-type": "application/x-www-form-urlencoded",
      cookie: `__Host-tumpel_connect=${csrf}`,
    },
    body: new URLSearchParams({
      request: consent.searchParams.get("request") ?? "",
      csrf,
      action: "approve",
    }).toString(),
  });
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const token = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
    }).toString(),
  });
  assert.equal(token.status, 200);
  return OAuthTokenSchema.parse(await token.json()).access_token;
};

const enrol = async (name = "box"): Promise<{ id: string; key: KeyObject }> => {
  const minted = await postJson("/v1/enrolment-tokens", { expiresInSeconds: 600 }, bearer);
  const { token } = MintedEnrolmentTokenSchema.parse(await minted.json());
  const dir = join(scratch, name);
  const tokenFile = join(scratch, `${name}.token`);
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const child = spawn(SUPERVISOR, ["enrol", "--endpoint", origin, "--token-file", tokenFile, "--name", name], {
    env: { ...process.env, TUMPEL_SUPERVISOR_DIR: dir },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  const enrolled = HostSchema.parse(JSON.parse(stdout));
  const stored = SupervisorHostKeySchema.parse(JSON.parse(readFileSync(join(dir, "host-key.json"), "utf8")));
  const key = createPrivateKey({ key: Buffer.from(stored.privateKey, "base64"), format: "der", type: "pkcs8" });
  return { id: enrolled.hostId, key };
};

const readAll = async (sessionId: string, turnId: string, limit: number) => {
  const lines: { lineSeq: number; text: string }[] = [];
  let cursor = 0;
  for (;;) {
    const page = await tool(
      "tumpel_transcript_read",
      { sessionId, turnId, after: cursor, limit },
      TranscriptPageSchema,
    );
    if (page.lines.length === 0) {
      assert.equal(page.cursor, cursor);
      return lines;
    }
    assert.ok(page.lines.length <= limit);
    lines.push(...page.lines.map((line) => ({ lineSeq: line.lineSeq, text: line.text })));
    assert.equal(page.cursor, page.lines.at(-1)?.lineSeq);
    cursor = page.cursor;
  }
};

const sessionStart = async (name = "Default") => {
  const personas = await getJson("/v1/personas", PersonaSchema.array());
  return {
    repository: "https://git.example.test/app.git",
    model: "claude-sonnet-test",
    personaId: personas.find((persona) => persona.name === name)?.personaId,
  };
};

const SETTINGS_FILE = '{"permissions":{"defaultMode":"bypassPermissions"}}';
const GIT_IDENTITY = { gitAuthorName: "Ticket Worker", gitAuthorEmail: "ticket-worker@example.test" };

const createPersona = async (name: string, secrets: unknown[], files: unknown[] = []): Promise<void> => {
  const created = await postJson("/v1/secret-sets", { name: `${name} secrets`, secrets }, bearer);
  assert.equal(created.status, 200);
  const { secretSetId } = SecretSetSchema.parse(await created.json());
  const persona = { name, harness: "ClaudeCode", secretSetId, files, ...GIT_IDENTITY };
  const personas = await getJson("/v1/personas", PersonaSchema.array());
  const existing = personas.find((candidate) => candidate.name === name);
  const written = await server.fetch(`${origin}/v1/personas${existing ? `/${existing.personaId}` : ""}`, {
    method: existing ? "PUT" : "POST",
    headers: { "content-type": "application/json", ...bearer },
    body: JSON.stringify(persona),
  });
  assert.equal(written.status, 200);
};

before(async () => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  scratch = mkdtempSync(join(ROOT, ".tmp", "sessions-e2e-"));
  certs = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => certs.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(certs.address() as AddressInfo).port}`;
  server = createTestHarness({
    root: fileURLToPath(new URL("..", import.meta.url)),
    workers: [
      {
        configPath: "./wrangler.jsonc",
        vars: {
          ACCESS_ISSUER: issuer,
          ACCESS_AUD: AUDIENCE,
          TUMPEL_SETTINGS: SETTINGS,
          R2_STUB_ORIGIN,
          SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");

  assert.equal((await postJson("/v1/tenants", { name: "Sessions", ...GIT_IDENTITY }, browser())).status, 200);
  bearer = { authorization: `Bearer ${await deviceToken()}` };
  mcpToken = await connectorToken();
  await createPersona(
    "Default",
    [
      { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: PROVIDER_KEY },
      { kind: "Variable", name: "GITHUB_TOKEN", value: "ghp-e2e" },
    ],
    [{ source: "Inline", path: ".claude/settings.json", content: Buffer.from(SETTINGS_FILE).toString("base64") }],
  );

  const enrolled = await enrol();
  hostId = enrolled.id;
  host = await HostSide.connect(hostId, enrolled.key);
  await eventually(
    "the host reading Online",
    () => getJson(`/v1/hosts/${hostId}`, HostSchema),
    (read) => read.state === "Online",
  );
  const [usage] = await getJson("/v1/hosts/usage", ReportedHostUsageSchema.array());
  assert.deepEqual(
    { hostId: usage?.hostId, boxCapacity: usage?.boxCapacity, boxesRunning: usage?.boxesRunning },
    { hostId, boxCapacity: 8, boxesRunning: 0 },
  );
});

after(async () => {
  host?.close();
  await server?.close();
  certs?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("a turn started over MCP reaches the host, its lines read back in order by cursor, and a snapshot follows", async () => {
  const started = await tool(
    "tumpel_session_start",
    { ...(await sessionStart()), prompt: "fix the build" },
    StartedSessionSchema,
  );
  assert.equal(started.session.hostId, hostId);
  assert.equal(started.turn.state, "Offered");

  const offer = await host.next("TurnOffer");
  assert.equal(offer.turnId, started.turn.turnId);
  assert.equal(offer.sessionId, started.session.sessionId);
  assert.equal(offer.prompt, "fix the build");
  assert.deepEqual(offer.credential.variables, [
    { name: "ANTHROPIC_API_KEY", value: PROVIDER_KEY },
    { name: "GITHUB_TOKEN", value: "ghp-e2e" },
  ]);
  assert.ok(Date.parse(offer.credential.expiresAt) > Date.now());
  assert.equal(offer.lastLineSeq, 0);
  assert.deepEqual(offer.snapshots, []);
  const digest = createHash("sha256").update(SETTINGS_FILE).digest("hex");
  assert.deepEqual(
    offer.personaFiles.map((file) => [file.path, file.digest, file.sizeBytes]),
    [[".claude/settings.json", digest, SETTINGS_FILE.length]],
  );
  assert.equal(new URL(offer.personaFiles[0]?.downloadUrl ?? "").origin, R2_STUB_ORIGIN);
  assert.match(offer.personaFiles[0]?.downloadUrl ?? "", new RegExp(`/persona-files/${digest}\\?X-Tumpel-Method=GET`));
  assert.deepEqual({ gitAuthorName: offer.gitAuthorName, gitAuthorEmail: offer.gitAuthorEmail }, GIT_IDENTITY);
  const { turnId } = offer;
  const { sessionId } = started.session;

  const handovers = await tool("tumpel_session_handovers", { sessionId }, CredentialHandoverSchema.array());
  assert.deepEqual(
    handovers.map(
      ({ sessionId: session, turnId: turn, hostId: host, boxId, variableNames, repositoryCredentialSource }) => ({
        session,
        turn,
        host,
        boxId,
        variableNames,
        repositoryCredentialSource,
      }),
    ),
    [
      {
        session: sessionId,
        turn: turnId,
        host: hostId,
        boxId: offer.boxId,
        variableNames: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"],
        repositoryCredentialSource: "SecretSet",
      },
    ],
  );
  assert.ok(!JSON.stringify(handovers).includes(PROVIDER_KEY));
  assert.ok(!JSON.stringify(handovers).includes("ghp-e2e"));

  host.send({ type: "TurnClaim", turnId, boxId: offer.boxId, cloneSeconds: CLONE_SECONDS });
  await eventually(
    "the turn reading Running",
    () => tool("tumpel_turn_get", { turnId }, TurnSchema),
    (turn) => turn.state === "Running",
  );
  const texts = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "on it" }] } }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
    }),
  ];
  texts.forEach((text, index) => {
    host.send({ type: "TurnLine", turnId, lineSeq: index + 1, text });
  });
  host.send({ type: "TurnLine", turnId, lineSeq: 2, text: "a resent line" });
  const expected = texts.map((text, index) => ({ lineSeq: index + 1, text }));
  await eventually(
    "three lines in the transcript",
    () => tool("tumpel_turn_get", { turnId }, TurnSchema),
    (turn) => turn.lineCount === 3,
  );
  assert.deepEqual(await readAll(sessionId, turnId, 10), expected);
  const chunked = await tool("tumpel_transcript_read", { sessionId, compact: true, limit: 10 }, TranscriptPageSchema);
  assert.deepEqual(
    chunked.lines.map(({ lineSeq, text }) => ({ lineSeq, text })),
    [{ lineSeq: 2, text: "on it" }],
  );
  assert.equal(chunked.cursor, 2);
  assert.equal(chunked.finished, false);
  const pending = await tool(
    "tumpel_transcript_read",
    { sessionId, compact: true, limit: 10, after: chunked.cursor },
    TranscriptPageSchema,
  );
  assert.deepEqual(
    pending.lines.map(({ lineSeq, text }) => ({ lineSeq, text })),
    [{ lineSeq: 3, text: "[Bash] npm test" }],
  );
  assert.equal(pending.cursor, 3);
  assert.equal(pending.finished, false);

  host.send({ type: "TurnComplete", turnId, lastLineSeq: 3, completedAt: new Date().toISOString() });
  const completed = await eventually(
    "the turn reading Completed",
    () => tool("tumpel_turn_get", { turnId }, TurnSchema),
    (turn) => turn.state === "Completed",
  );
  assert.equal(completed.lineCount, 3);
  assert.deepEqual(await readAll(sessionId, turnId, 10), expected);
  assert.deepEqual(await readAll(sessionId, turnId, 1), expected);
  const first = await tool("tumpel_transcript_read", { sessionId, limit: 1 }, TranscriptPageSchema);
  assert.equal(first.cursor, 1);
  assert.equal(first.finished, false);
  const last = await tool("tumpel_transcript_read", { sessionId, after: 2 }, TranscriptPageSchema);
  assert.equal(last.cursor, 3);
  assert.equal(last.finished, true);

  const request = await host.next("SnapshotRequest");
  assert.equal(request.sessionId, sessionId);
  assert.equal(request.turnId, turnId);
  assert.equal(request.snapshotSeq, 1);
  const upload = new URL(request.uploadUrl);
  assert.equal(upload.origin, R2_STUB_ORIGIN);
  assert.equal(upload.pathname, `/tumpel-sessions/${request.storageKey}`);
  assert.equal(upload.searchParams.get("X-Tumpel-Method"), "PUT");
  assert.ok(Date.parse(request.uploadExpiresAt) > Date.now());
  await (await server.getWorker<{ STORE: Store }>().getEnv()).STORE.put(request.storageKey, '{"entries":[]}');
  host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 4096 });
  const [snapshot] = await eventually(
    "a stored snapshot",
    () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
    (snapshots) => snapshots.length === 1,
  );
  assert.deepEqual(
    { ...snapshot, createdAt: 0, updatedAt: 0 },
    {
      snapshotId: request.snapshotId,
      tenantId: started.session.tenantId,
      sessionId,
      boxId: offer.boxId,
      turnId,
      snapshotSeq: 1,
      storageKey: request.storageKey,
      outcome: { state: "Stored", uploadedBytes: 4096 },
      createdAt: 0,
      updatedAt: 0,
    },
  );
  assert.deepEqual(await tool("tumpel_snapshot_get", { snapshotId: request.snapshotId }, SnapshotSchema), snapshot);

  await tool("tumpel_turn_send", { sessionId, prompt: "and now the tests" }, TurnSchema);
  const next = await host.next("TurnOffer");
  assert.equal(next.lastLineSeq, 3);
  assert.deepEqual(
    next.snapshots.map(({ snapshotId, snapshotSeq, storageKey }) => ({ snapshotId, snapshotSeq, storageKey })),
    [{ snapshotId: request.snapshotId, snapshotSeq: 1, storageKey: request.storageKey }],
  );
  assert.equal(new URL(next.snapshots[0]?.downloadUrl ?? "").searchParams.get("X-Tumpel-Method"), "GET");
  await eventually(
    "the unclaimed second turn reading Failed",
    () => getJson(`/v1/turns/${next.turnId}`, TurnSchema),
    (turn) => turn.state === "Failed",
  );
});

const deletePersona = (personaId: string) => call(`/v1/personas/${personaId}`, { method: "DELETE", headers: bearer });

test("a stop snapshots an idle session and frees its box, and an archive deletes its snapshots, keeps its transcript and refuses later sends, and its persona stays", async () => {
  const store = (await server.getWorker<{ STORE: Store }>().getEnv()).STORE;
  await createPersona("Archivable", [
    { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: PROVIDER_KEY },
  ]);
  const start = await sessionStart("Archivable");
  const started = await tool("tumpel_session_start", { ...start, prompt: "stop me" }, StartedSessionSchema);
  const { sessionId } = started.session;
  const offer = await host.next("TurnOffer");
  assert.equal(offer.sessionId, sessionId);
  const { turnId } = offer;
  host.send({ type: "TurnClaim", turnId, boxId: offer.boxId, cloneSeconds: CLONE_SECONDS });
  await eventually(
    "the turn reading Running",
    () => tool("tumpel_turn_get", { turnId }, TurnSchema),
    (turn) => turn.state === "Running",
  );
  const inFlight = await refused(`/v1/sessions/${sessionId}/stop`);
  assert.equal(inFlight.code, "TurnInFlight");
  assert.match(inFlight.detail, new RegExp(turnId));

  host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result"}' });
  host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  await eventually(
    "the turn reading Completed",
    () => tool("tumpel_turn_get", { turnId }, TurnSchema),
    (turn) => turn.state === "Completed",
  );
  const notStopped = await refused(`/v1/sessions/${sessionId}/archive`);
  assert.equal(notStopped.code, "SessionNotStopped");
  assert.match(notStopped.detail, /is Idle/);

  const stopping = await tool("tumpel_session_stop", { sessionId }, SessionSchema);
  assert.equal(stopping.state, "Stopping");
  const request = await host.next("SnapshotRequest");
  assert.equal(request.sessionId, sessionId);
  assert.equal(request.turnId, turnId);
  await store.put(request.storageKey, "snapshot bytes");
  host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
  const teardown = await host.next("BoxTeardown");
  assert.deepEqual(teardown, { type: "BoxTeardown", sessionId, boxId: offer.boxId });
  assert.equal((await tool("tumpel_session_get", { sessionId }, SessionSchema)).state, "Stopping");
  host.send({ type: "BoxGone", sessionId, boxId: teardown.boxId });
  await eventually(
    "the session reading Stopped",
    () => tool("tumpel_session_get", { sessionId }, SessionSchema),
    (session) => session.state === "Stopped",
  );

  const inUse = await deletePersona(start.personaId ?? "");
  assert.equal(inUse.status, 409);
  assert.match(
    ProblemSchema.parse(await inUse.json()).detail,
    new RegExp(`persona ${start.personaId} is the persona of session ${sessionId}$`),
  );

  const archived = await tool("tumpel_session_archive", { sessionId }, SessionSchema);
  assert.equal(archived.state, "Archived");
  assert.equal(await store.head(request.storageKey), null);
  assert.deepEqual(await tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()), []);
  assert.deepEqual(await readAll(sessionId, turnId, 10), [{ lineSeq: 1, text: '{"type":"result"}' }]);
  const archivedSend = await refused(`/v1/sessions/${sessionId}/turns`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "one more" }),
  });
  assert.equal(archivedSend.code, "SessionArchived");
  assert.match(archivedSend.detail, new RegExp(`session ${sessionId} is archived`));
  assert.equal((await deletePersona(start.personaId ?? "")).status, 409);
});

test("a stop whose teardown the host refuses returns the session to Idle with the failure and snapshots its box again", async () => {
  const started = await tool(
    "tumpel_session_start",
    { ...(await sessionStart()), prompt: "keep my box" },
    StartedSessionSchema,
  );
  const { sessionId } = started.session;
  const offer = await host.next("TurnOffer");
  const { turnId } = offer;
  host.send({ type: "TurnClaim", turnId, boxId: offer.boxId, cloneSeconds: CLONE_SECONDS });
  host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result"}' });
  host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  const store = (await server.getWorker<{ STORE: Store }>().getEnv()).STORE;
  const warm = await host.next("SnapshotRequest");
  await store.put(warm.storageKey, '{"entries":[]}');
  host.send({ type: "SnapshotDone", snapshotId: warm.snapshotId, uploadedBytes: 14 });
  await eventually(
    "a stored snapshot",
    () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
    (snapshots) => snapshots.length === 1,
  );

  await tool("tumpel_session_stop", { sessionId }, SessionSchema);
  const teardown = await host.next("BoxTeardown");
  const failedAt = new Date().toISOString();
  const detail = `box ${teardown.boxId} holds turn ${turnId}, which no snapshot holds; snapshot it, then tear it down`;
  host.send({ type: "BoxTeardownFailed", sessionId, boxId: teardown.boxId, reason: "BoxDirty", detail, failedAt });
  const idle = await eventually(
    "the session reading Idle",
    () => getJson(`/v1/sessions/${sessionId}`, SessionSchema),
    (session) => session.state === "Idle",
  );
  assert.equal(idle.state, "Idle");
  const failures = await tool("tumpel_session_stop_failures", { sessionId }, StopFailureSchema.array());
  assert.deepEqual(
    failures.map((failure) => [failure.sessionId, failure.reason, failure.detail, failure.failedAt]),
    [[sessionId, "BoxDirty", detail, failedAt]],
  );

  const again = await host.next("SnapshotRequest");
  assert.equal(again.sessionId, sessionId);
  assert.equal(again.turnId, turnId);
  await store.put(again.storageKey, '{"entries":[]}');
  host.send({ type: "SnapshotDone", snapshotId: again.snapshotId, uploadedBytes: 14 });
  await eventually(
    "a second stored snapshot",
    () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
    (snapshots) => snapshots.length === 2,
  );
});

test("a stop whose snapshot fails returns the session to Idle and does not ask for that snapshot again", async () => {
  const started = await tool(
    "tumpel_session_start",
    { ...(await sessionStart()), prompt: "fail my snapshot" },
    StartedSessionSchema,
  );
  const { sessionId } = started.session;
  const offer = await host.next("TurnOffer");
  const { turnId } = offer;
  host.send({ type: "TurnClaim", turnId, boxId: offer.boxId, cloneSeconds: CLONE_SECONDS });
  host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result"}' });
  host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  const warm = await host.next("SnapshotRequest");

  await tool("tumpel_session_stop", { sessionId }, SessionSchema);
  host.send({
    type: "SnapshotFailed",
    snapshotId: warm.snapshotId,
    reason: "UploadRejected",
    detail: "the store refused the upload",
    failedAt: new Date().toISOString(),
  });
  await eventually(
    "the session reading Idle",
    () => getJson(`/v1/sessions/${sessionId}`, SessionSchema),
    (session) => session.state === "Idle",
  );

  await sleep(SETTINGS.snapshotDelaySeconds * 3000);
  assert.equal(host.snapshotRequestsFor(sessionId), 0);
});

const completedTurn = async (prompt: string) => {
  const started = await tool("tumpel_session_start", { ...(await sessionStart()), prompt }, StartedSessionSchema);
  const offer = await host.next("TurnOffer");
  assert.equal(offer.sessionId, started.session.sessionId);
  host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId, cloneSeconds: CLONE_SECONDS });
  host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: '{"type":"result"}' });
  host.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  return { session: started.session, offer };
};

type Placement = { digest: string; packDigest: string; offset: number; length: number };

const CHUNK_BYTES = 10;

const placed = (packs: Record<string, string[]>): Placement[] =>
  Object.entries(packs).flatMap(([packDigest, digests]) =>
    digests.map((digest, index) => ({ digest, packDigest, offset: index * CHUNK_BYTES, length: CHUNK_BYTES })),
  );

const storedChunks = async (
  store: Store,
  sessionId: string,
  digests: string[],
  packs: Record<string, string[]>,
): Promise<{
  request: Extract<ControlMessage, { type: "SnapshotRequest" }>;
  held: Placement[];
  uploaded: string[];
}> => {
  const request = await host.next("SnapshotRequest");
  assert.equal(request.sessionId, sessionId);
  host.send({ type: "SnapshotChunks", snapshotId: request.snapshotId, part: 1, digests });
  const answer = await host.next("SnapshotChunksHeld");
  assert.equal(answer.snapshotId, request.snapshotId);
  assert.equal(answer.part, 1);
  const chunks = placed(packs);
  host.send({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: 1,
    packs: Object.entries(packs).map(([packDigest, held]) => ({ packDigest, sizeBytes: held.length * CHUNK_BYTES })),
    chunks,
  });
  const uploads = await host.next("SnapshotPackUploads");
  assert.equal(uploads.uploadExpiresAt, request.uploadExpiresAt);
  for (const upload of uploads.uploads) {
    const url = new URL(upload.url);
    assert.equal(url.pathname, `/tumpel-sessions/${request.storageKey.split("/")[0]}/packs/${upload.packDigest}`);
    assert.equal(url.searchParams.get("X-Tumpel-Method"), "PUT");
    assert.equal(url.searchParams.get("X-Tumpel-Checksum"), Buffer.from(upload.packDigest, "hex").toString("base64"));
    await store.put(url.pathname.replace("/tumpel-sessions/", ""), "pack bytes");
  }
  await store.put(request.storageKey, '{"manifest":[]}');
  host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 64 });
  await eventually(
    "a stored snapshot",
    () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
    (snapshots) => snapshots.some((snapshot) => snapshot.outcome.state === "Stored"),
  );
  return { request, held: answer.held, uploaded: uploads.uploads.map((upload) => upload.packDigest) };
};

test("a snapshot learns where the tenant holds its chunks and uploads only new packs, a restore gets only its session's packs, and an archive deletes the packs no live chunk lies in", async () => {
  const store = (await server.getWorker<{ STORE: Store }>().getEnv()).STORE;
  const [one, two, three] = ["1", "2", "3"].map((digit) => digit.repeat(64)) as [string, string, string];
  const [packOne, packTwo, packThree] = ["a", "b", "c"].map((digit) => digit.repeat(64)) as [string, string, string];
  const first = await completedTurn("chunk the first");
  const { request, held, uploaded } = await storedChunks(store, first.session.sessionId, [one, two], {
    [packOne]: [one],
    [packTwo]: [two],
  });
  assert.deepEqual(held, []);
  assert.deepEqual(uploaded, [packOne, packTwo]);
  const tenantId = request.storageKey.split("/")[0] ?? "";

  const second = await completedTurn("chunk the second");
  const shared = await storedChunks(store, second.session.sessionId, [two, three, three], { [packThree]: [three] });
  assert.deepEqual(shared.held, [{ digest: two, packDigest: packTwo, offset: 0, length: CHUNK_BYTES }]);
  assert.deepEqual(shared.uploaded, [packThree]);

  await tool("tumpel_turn_send", { sessionId: first.session.sessionId, prompt: "restore me" }, TurnSchema);
  const restoring = await host.next("TurnOffer");
  assert.deepEqual(
    restoring.snapshots.map((snapshot) => snapshot.snapshotId),
    [request.snapshotId],
  );
  host.send({
    type: "RestoreChunks",
    turnId: restoring.turnId,
    part: 1,
    chunks: [...placed({ [packOne]: [one], [packTwo]: [two], [packThree]: [three] })],
  });
  const downloads = await host.next("RestoreDownloads");
  assert.equal(downloads.turnId, restoring.turnId);
  assert.equal(downloads.downloadExpiresAt, restoring.snapshots[0]?.downloadExpiresAt);
  assert.deepEqual(
    downloads.packs.map((pack) => [
      pack.packDigest,
      pack.sizeBytes,
      new URL(pack.url).searchParams.get("X-Tumpel-Method"),
    ]),
    [
      [packOne, CHUNK_BYTES, "GET"],
      [packTwo, CHUNK_BYTES, "GET"],
    ],
  );
  await eventually(
    "the unclaimed restore turn reading Failed",
    () => getJson(`/v1/turns/${restoring.turnId}`, TurnSchema),
    (turn) => turn.state === "Failed",
  );

  await tool(
    "tumpel_turn_send",
    { sessionId: second.session.sessionId, prompt: "restore the shared pack" },
    TurnSchema,
  );
  const reusing = await host.next("TurnOffer");
  host.send({ type: "RestoreChunks", turnId: reusing.turnId, part: 1, chunks: [...placed({ [packTwo]: [two] })] });
  const reused = await host.next("RestoreDownloads");
  assert.deepEqual(
    reused.packs.map((pack) => pack.packDigest),
    [packTwo],
  );
  await eventually(
    "the unclaimed shared restore turn reading Failed",
    () => getJson(`/v1/turns/${reusing.turnId}`, TurnSchema),
    (turn) => turn.state === "Failed",
  );

  await tool("tumpel_session_stop", { sessionId: first.session.sessionId }, SessionSchema);
  const teardown = await host.next("BoxTeardown");
  host.send({ type: "BoxGone", sessionId: first.session.sessionId, boxId: teardown.boxId });
  await eventually(
    "the session reading Stopped",
    () => tool("tumpel_session_get", { sessionId: first.session.sessionId }, SessionSchema),
    (session) => session.state === "Stopped",
  );
  await tool("tumpel_session_archive", { sessionId: first.session.sessionId }, SessionSchema);
  assert.equal(await store.head(`${tenantId}/packs/${packOne}`), null);
  assert.notEqual(await store.head(`${tenantId}/packs/${packTwo}`), null);
  assert.notEqual(await store.head(`${tenantId}/packs/${packThree}`), null);

  const third = await completedTurn("chunk the third");
  const again = await storedChunks(store, third.session.sessionId, [one, two], { [packOne]: [one] });
  assert.deepEqual(
    again.held.map((placement) => placement.digest),
    [two],
  );
  assert.deepEqual(again.uploaded, [packOne]);
});

test("a turn the host never claims fails NotClaimed once the claim budget runs out", async () => {
  const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "never claimed" }, bearer);
  assert.equal(response.status, 200);
  const started = StartedSessionSchema.parse(await response.json());
  const offer = await host.next("TurnOffer");
  assert.equal(offer.turnId, started.turn.turnId);

  const failed = await eventually(
    "the turn reading Failed",
    () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
    (turn) => turn.state === "Failed",
  );
  assert.ok(failed.updatedAt - started.turn.createdAt >= CLAIM_BUDGET_SECONDS * 1000);
  const failure = await getJson(`/v1/turns/${offer.turnId}/failure`, TurnFailureSchema);
  assert.equal(failure.reason, "NotClaimed");
  assert.match(failure.detail, new RegExp(`did not claim turn ${offer.turnId} within ${CLAIM_BUDGET_SECONDS} seconds`));
});

test("a claimed turn whose TurnRepositoryReady is lost fails NoFirstOutput once the clone and first-line budgets run out", async () => {
  const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "ready never arrives" }, bearer);
  assert.equal(response.status, 200);
  const started = StartedSessionSchema.parse(await response.json());
  const offer = await host.next("TurnOffer");
  assert.equal(offer.turnId, started.turn.turnId);
  host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId, cloneSeconds: CLONE_SECONDS });
  const claimedAt = Date.now();

  const failed = await eventually(
    "the turn reading Failed",
    () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
    (turn) => turn.state === "Failed",
    (CLONE_SECONDS + FIRST_LINE_BUDGET_SECONDS + 10) * 1000,
  );
  assert.ok(failed.updatedAt - claimedAt >= (CLONE_SECONDS + FIRST_LINE_BUDGET_SECONDS) * 1000 - 500);
  const failure = await getJson(`/v1/turns/${offer.turnId}/failure`, TurnFailureSchema);
  assert.equal(failure.reason, "NoFirstOutput");
  assert.match(failure.detail, new RegExp(`no line for turn ${offer.turnId}`));
});

test("a clone refused without GITHUB_TOKEN in the handover asks for it in the persona's secret set, and no other clone failure does", async () => {
  await createPersona("NoGithub", [{ kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: PROVIDER_KEY }]);
  for (const [name, cause, asks] of [
    ["NoGithub", "Refused", true],
    ["NoGithub", "TimedOut", false],
    ["NoGithub", "DirectoryNotEmpty", false],
    ["NoGithub", "Other", false],
    ["Default", "Refused", false],
  ] as const) {
    const response = await postJson("/v1/sessions", { ...(await sessionStart(name)), prompt: "clone fails" }, bearer);
    assert.equal(response.status, 200);
    const offer = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId, cloneSeconds: CLONE_SECONDS });
    host.send({
      type: "TurnRepositoryCloneFailed",
      turnId: offer.turnId,
      cause,
      detail: "git reported: fatal: could not read Username",
      failedAt: new Date().toISOString(),
    });
    await eventually(
      "the turn reading Failed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    const failure = await getJson(`/v1/turns/${offer.turnId}/failure`, TurnFailureSchema);
    assert.equal(failure.reason, "RepositoryCloneFailed");
    assert.equal(/needs a Variable member GITHUB_TOKEN/.test(failure.detail), asks, failure.detail);
    assert.match(failure.detail, new RegExp(`secret set ${name} secrets`));
  }
});

test("a session whose subscription token has expired is refused CredentialExpired at start, and no offer reaches the host", async () => {
  await createPersona("Expired", [
    {
      kind: "SubscriptionToken",
      name: "CLAUDE_SUBSCRIPTION",
      provider: "Anthropic",
      expiresAt: "2026-01-01T00:00:00+01:00",
      value: "expired-oauth-token",
    },
  ]);
  const response = await postJson("/v1/sessions", { ...(await sessionStart("Expired")), prompt: "too late" }, bearer);
  assert.equal(response.status, 422);
  const refused = ProblemSchema.parse(await response.json());
  assert.equal(refused.code, "CredentialExpired");
  assert.match(refused.detail, /CLAUDE_SUBSCRIPTION/);
});

test("a claimed turn fails HostOffline when its host disconnects and does not come back", async () => {
  const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "host goes away" }, bearer);
  assert.equal(response.status, 200);
  const started = StartedSessionSchema.parse(await response.json());
  const offer = await host.next("TurnOffer");
  assert.equal(offer.turnId, started.turn.turnId);
  host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId, cloneSeconds: CLONE_SECONDS });
  host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: "{}" });
  await eventually(
    "the turn reading Running",
    () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
    (turn) => turn.state === "Running" && turn.lineCount === 1,
  );

  host.close();
  await eventually(
    "the turn reading Failed",
    () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
    (turn) => turn.state === "Failed",
    HOST_OFFLINE_GRACE_MS + 20_000,
  );
  const failure = await getJson(`/v1/turns/${offer.turnId}/failure`, TurnFailureSchema);
  assert.equal(failure.reason, "HostOffline");
  assert.match(failure.detail, new RegExp(`went offline during turn ${offer.turnId}`));

  const offline = await refused(`/v1/sessions/${started.session.sessionId}/stop`);
  assert.equal(offline.code, "HostOffline");
  assert.match(offline.detail, new RegExp(`host box \\(${hostId}\\), which is Offline`));
});

const hostState = (id: string, state: string) =>
  eventually(
    `host ${id} reading ${state}`,
    () => getJson(`/v1/hosts/${id}`, HostSchema),
    (read) => read.state === state,
  );

test("a session moves off its offline host once a snapshot holds its last completed turn, and the old host's late frames leave its channel working", async () => {
  const store = (await server.getWorker<{ STORE: Store }>().getEnv()).STORE;
  const first = await enrol("move-from");
  let from = await HostSide.connect(first.id, first.key, 16);
  await hostState(first.id, "Online");
  const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "move me" }, bearer);
  assert.equal(response.status, 200, await response.clone().text());
  const started = StartedSessionSchema.parse(await response.json());
  const { sessionId } = started.session;
  assert.equal(started.session.hostId, first.id);
  const offer = await from.next("TurnOffer");
  from.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId, cloneSeconds: CLONE_SECONDS });
  from.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: "{}" });
  from.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  const request = await from.next("SnapshotRequest");

  from.close();
  await hostState(first.id, "Offline");
  const stranded = await refused(`/v1/sessions/${sessionId}/turns`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "not yet" }),
  });
  assert.equal(stranded.code, "HostOffline");
  assert.match(
    stranded.detail,
    new RegExp(
      `move-from \\(${first.id}\\), which is Offline, and its snapshots miss completed turns ${offer.turnId},`,
    ),
  );

  from = await HostSide.connect(first.id, first.key, 16, from.counters());
  await hostState(first.id, "Online");
  await store.put(request.storageKey, '{"entries":[]}');
  from.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
  await eventually(
    "a stored snapshot",
    () => getJson(`/v1/sessions/${sessionId}/snapshots`, SnapshotSchema.array()),
    (snapshots) => snapshots.length === 1,
  );
  const unclaimed = await postJson(`/v1/sessions/${sessionId}/turns`, { prompt: "never claimed" }, bearer);
  assert.equal(unclaimed.status, 200, await unclaimed.clone().text());
  const lost = TurnSchema.parse(await unclaimed.json());
  assert.equal((await from.next("TurnOffer")).turnId, lost.turnId);
  from.close();
  await hostState(first.id, "Offline");
  await eventually(
    "the unclaimed turn reading Failed",
    () => getJson(`/v1/turns/${lost.turnId}`, TurnSchema),
    (turn) => turn.state === "Failed",
  );

  const second = await enrol("move-to");
  const to = await HostSide.connect(second.id, second.key, 16);
  await hostState(second.id, "Online");
  const sent = await postJson(`/v1/sessions/${sessionId}/turns`, { prompt: "on the new host" }, bearer);
  assert.equal(sent.status, 200, await sent.clone().text());
  const moved = TurnSchema.parse(await sent.json());
  const session = await getJson(`/v1/sessions/${sessionId}`, SessionSchema);
  assert.equal(session.hostId, second.id);
  assert.notEqual(session.boxId, offer.boxId);
  const movedOffer = await to.next("TurnOffer");
  assert.equal(movedOffer.turnId, moved.turnId);
  assert.equal(movedOffer.boxId, session.boxId);
  assert.deepEqual(
    movedOffer.snapshots.map((snapshot) => snapshot.snapshotId),
    [request.snapshotId],
  );

  from = await HostSide.connect(first.id, first.key, 16, from.counters());
  await hostState(first.id, "Online");
  const discard = await from.next("BoxDiscard");
  assert.deepEqual({ sessionId: discard.sessionId, boxId: discard.boxId }, { sessionId, boxId: offer.boxId });
  from.send({ type: "TurnClaim", turnId: lost.turnId, boxId: offer.boxId, cloneSeconds: CLONE_SECONDS });
  from.send({
    type: "TurnFailed",
    turnId: lost.turnId,
    reason: "HarnessExited",
    detail: "the late failure of a turn the session left",
    failedAt: new Date().toISOString(),
  });
  from.send({ type: "BoxGone", sessionId, boxId: offer.boxId });

  const next = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "after the move" }, bearer);
  assert.equal(next.status, 200, await next.clone().text());
  const after = StartedSessionSchema.parse(await next.json());
  assert.equal(after.session.hostId, first.id);
  const afterOffer = await from.next("TurnOffer");
  from.send({ type: "TurnClaim", turnId: afterOffer.turnId, boxId: afterOffer.boxId, cloneSeconds: CLONE_SECONDS });
  await eventually(
    "the turn on the old host reading Running",
    () => getJson(`/v1/turns/${afterOffer.turnId}`, TurnSchema),
    (turn) => turn.state === "Running",
  );
  assert.equal((await getJson(`/v1/turns/${lost.turnId}/failure`, TurnFailureSchema)).reason, "NotClaimed");
  from.close();
  to.close();
});

test("two sessions started at once on two equal hosts land on different hosts, since each counts the other's turn", async () => {
  const first = await enrol("equal-1");
  const second = await enrol("equal-2");
  const sides = [await HostSide.connect(first.id, first.key, 32), await HostSide.connect(second.id, second.key, 32)];
  await eventually(
    "both equal hosts reading Online",
    () => getJson("/v1/hosts", HostSchema.array()),
    (hosts) => [first.id, second.id].every((id) => hosts.find((listed) => listed.hostId === id)?.state === "Online"),
  );
  const start = await sessionStart();
  const responses = await Promise.all(
    ["one", "two"].map((prompt) => postJson("/v1/sessions", { ...start, prompt }, bearer)),
  );
  const placed: string[] = [];
  for (const response of responses) {
    assert.equal(response.status, 200, await response.clone().text());
    placed.push(StartedSessionSchema.parse(await response.json()).session.hostId);
  }
  assert.deepEqual(placed.toSorted(), [first.id, second.id].toSorted());
  for (const side of sides) side.close();
});
