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
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  HostSchema,
  MintedEnrolmentTokenSchema,
  OAuthClientSchema,
  OAuthTokenSchema,
  PersonaSchema,
  SecretSetSchema,
  SnapshotSchema,
  StartedSessionSchema,
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
const R2_STUB_ORIGIN = "https://r2.example.test";
const HOST_OFFLINE_GRACE_MS = 30_000;
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SUPERVISOR = join(ROOT, "target", "debug", "tumpel-supervisor");
const SETTINGS = {
  dispatchGrantTtlSeconds: 300,
  snapshotDelaySeconds: 1,
  snapshotDeadlineSeconds: 60,
  turnClaimBudgetSeconds: CLAIM_BUDGET_SECONDS,
  turnFirstLineBudgetSeconds: 10,
  turnTotalBudgetSeconds: 60,
  transcriptChunkLines: 2,
};

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

type ControlEnvelope = z.infer<typeof ControlEnvelopeSchema>;
type ControlMessage = Extract<ControlEnvelope, { type: "Frame" }>["message"];
type HostMessage = { type: string } & Record<string, unknown>;

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

class HostSide {
  private received = 0;
  private sent = 0;
  private readonly inbox: ControlMessage[] = [];
  private readonly waiters: (() => void)[] = [];
  private readonly heartbeat: NodeJS.Timeout;

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    this.heartbeat = setInterval(() => this.raw({ type: "Heartbeat", sentAt: new Date().toISOString() }), 10_000);
  }

  static async connect(id: string, key: KeyObject): Promise<HostSide> {
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/v1/hosts/${id}/channel`);
    const challenge = await new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
      socket.addEventListener("error", () => reject(new Error("the host channel did not open")), { once: true });
    });
    const parsed = ControlEnvelopeSchema.parse(JSON.parse(challenge));
    assert.equal(parsed.type, "Challenge");
    const side = new HostSide(socket);
    side.raw({
      type: "Hello",
      hostId: id,
      protocolVersion: 1,
      supervisorVersion: "0.1.0",
      signature: sign(null, helloBytes(parsed.nonce, id), key).toString("base64"),
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

const enrol = async (): Promise<{ id: string; key: KeyObject }> => {
  const minted = await postJson("/v1/enrolment-tokens", { expiresInSeconds: 600 }, bearer);
  const { token } = MintedEnrolmentTokenSchema.parse(await minted.json());
  const dir = join(scratch, "host");
  const tokenFile = join(scratch, "host.token");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  const child = spawn(SUPERVISOR, ["enrol", "--endpoint", origin, "--token-file", tokenFile, "--name", "box"], {
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
    harness: "ClaudeCode",
    model: "claude-sonnet-test",
    personaId: personas.find((persona) => persona.name === name)?.personaId,
  };
};

const createPersona = async (name: string, secrets: unknown[]): Promise<void> => {
  const created = await postJson("/v1/secret-sets", { name: `${name} secrets`, secrets }, bearer);
  assert.equal(created.status, 200);
  const { secretSetId } = SecretSetSchema.parse(await created.json());
  const persona = { name, secretSetId, instructions: "", settings: "{}", mcpServers: [] };
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

  assert.equal((await postJson("/v1/tenants", { name: "Sessions" }, browser())).status, 200);
  bearer = { authorization: `Bearer ${await deviceToken()}` };
  mcpToken = await connectorToken();
  await createPersona("Default", [
    { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: PROVIDER_KEY },
    { kind: "Variable", name: "GITHUB_TOKEN", value: "ghp-e2e" },
  ]);

  const enrolled = await enrol();
  hostId = enrolled.id;
  host = await HostSide.connect(hostId, enrolled.key);
  await eventually(
    "the host reading Online",
    () => getJson(`/v1/hosts/${hostId}`, HostSchema),
    (read) => read.state === "Online",
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
  const { turnId } = offer;
  const { sessionId } = started.session;

  host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
  await eventually(
    "the turn reading Running",
    () => tool("tumpel_turn_get", { turnId }, TurnSchema),
    (turn) => turn.state === "Running",
  );
  const texts = ['{"type":"system"}', '{"type":"assistant","text":"on it"}', '{"type":"result"}'];
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

  host.send({ type: "TurnComplete", turnId, lastLineSeq: 3, completedAt: new Date().toISOString() });
  const completed = await eventually(
    "the turn reading Completed",
    () => tool("tumpel_turn_get", { turnId }, TurnSchema),
    (turn) => turn.state === "Completed",
  );
  assert.equal(completed.lineCount, 3);
  assert.deepEqual(await readAll(sessionId, turnId, 10), expected);
  assert.deepEqual(await readAll(sessionId, turnId, 1), expected);

  const request = await host.next("SnapshotRequest");
  assert.equal(request.sessionId, sessionId);
  assert.equal(request.turnId, turnId);
  assert.equal(request.snapshotSeq, 1);
  const upload = new URL(request.uploadUrl);
  assert.equal(upload.origin, R2_STUB_ORIGIN);
  assert.equal(upload.pathname, `/tumpel-sessions/${request.storageKey}`);
  assert.equal(upload.searchParams.get("X-Tumpel-Method"), "PUT");
  assert.ok(Date.parse(request.uploadExpiresAt) > Date.now());
  host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, sizeBytes: 4096 });
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
      outcome: { state: "Stored", sizeBytes: 4096 },
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

test("a turn whose subscription token has expired fails CredentialExpired when it is offered, and its key never reaches the host", async () => {
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
  assert.equal(response.status, 200);
  const started = StartedSessionSchema.parse(await response.json());
  const withdrawn = await host.next("TurnWithdrawn");
  assert.equal(withdrawn.turnId, started.turn.turnId);
  const failure = await eventually(
    "the turn's failure",
    async () => {
      const read = await server.fetch(`${origin}/v1/turns/${started.turn.turnId}/failure`, { headers: bearer });
      return read.status === 200 ? TurnFailureSchema.parse(await read.json()) : null;
    },
    (read) => read !== null,
  );
  assert.equal(failure?.reason, "CredentialExpired");
  assert.match(failure?.detail ?? "", /CLAUDE_SUBSCRIPTION/);
});

test("a claimed turn fails HostOffline when its host disconnects and does not come back", async () => {
  const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "host goes away" }, bearer);
  assert.equal(response.status, 200);
  const started = StartedSessionSchema.parse(await response.json());
  const offer = await host.next("TurnOffer");
  assert.equal(offer.turnId, started.turn.turnId);
  host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
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
});
