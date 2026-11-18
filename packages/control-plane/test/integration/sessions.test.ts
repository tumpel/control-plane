import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, suite, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  ChannelProtocol,
  ClaudeSetupSchema,
  CompactTranscriptPageSchema,
  CredentialHandoverSchema,
  HostSchema,
  MintedEnrolmentTokenSchema,
  OAuthClientSchema,
  OAuthTokenSchema,
  PersonaSchema,
  PrebuildSchema,
  ProblemSchema,
  RawTranscriptPageSchema,
  ReleaseRolloutSchema,
  ReportedHostUsageSchema,
  SecretSetSchema,
  SessionSchema,
  SnapshotSchema,
  StartedSessionFromIssueSchema,
  StartedSessionSchema,
  StopFailureSchema,
  SupervisorHostKeySchema,
  TurnFailureSchema,
  TurnSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import { createTestHarness, type TestHarness } from "wrangler";
import { z } from "zod";
import { ControlEnvelopeSchema, helloBytes } from "../../src/channel/protocol.ts";
import { generateDataKey, seal } from "../../src/envelope.ts";
import { CLAUDE_CODE_VERSION, CODEX_VERSION } from "../../src/harness-catalog.ts";
import { workersSecretKeyStore } from "../../src/key-store.ts";
import type { ReleaseManifest } from "../../src/releases.ts";
import {
  type ChunkLedger,
  type ChunkStore,
  ChunkWriter,
  decodeLines,
  type TranscriptLine,
} from "../../src/transcript.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "../release-fixture.ts";
import { GIVE_UP_MS, TEST_SETTINGS, until } from "../timing.ts";

const AUDIENCE = "tumpel-sessions-e2e";
const DEPLOYED_COMMIT = "7".repeat(40);
const KID = "sessions-e2e-key";
const CALLBACK = "https://client.example.test/callback";
const PROVIDER_KEY = "sk-sessions-e2e-provider-key";
const CLAIM_BUDGET_SECONDS = 3;
const IMAGE_FETCH_BUDGET_SECONDS = 2;
const FIRST_LINE_BUDGET_SECONDS = 10;
const R2_STUB_ORIGIN = "https://r2.example.test";
const USAGE = { boxesWarm: 0, loadAverage: 0.25, memoryAvailableMib: 6144 };
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const SUPERVISOR = join(ROOT, ".tmp", "release-binaries", "tumpel-supervisor");
const SETTINGS = {
  ...TEST_SETTINGS,
  dispatchGrantTtlSeconds: CLAIM_BUDGET_SECONDS + IMAGE_FETCH_BUDGET_SECONDS - 1,
  snapshotDelaySeconds: 1,
  snapshotDeadlineSeconds: 60,
  turnClaimBudgetSeconds: CLAIM_BUDGET_SECONDS,
  turnImageFetchBudgetSeconds: IMAGE_FETCH_BUDGET_SECONDS,
  turnFirstLineBudgetSeconds: FIRST_LINE_BUDGET_SECONDS,
  turnTotalBudgetSeconds: 60,
  transcriptChunkLines: 2,
  prebuildUploadBudgetSeconds: 60,
};

type WorkerConfig = Extract<
  Extract<Parameters<typeof createTestHarness>[0], object>["workers"][number],
  { config: unknown }
>["config"];

const { env: _stages, ...config }: WorkerConfig & { env?: unknown } = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)), "utf8"),
);

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

type ControlEnvelope = z.infer<typeof ControlEnvelopeSchema>;
type ControlMessage = Extract<ControlEnvelope, { type: "Frame" }>["message"];
type HostMessage = { type: string } & Record<string, unknown>;

const signal = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const KERNEL_DIGEST = "c".repeat(64);
const BASE_DIGEST = "3".repeat(64);
const BASE_MANIFEST_DIGEST = "4".repeat(64);
const RELEASE: ReleaseManifest = {
  ...CLAUDE_CODE_AMD64_RELEASE,
  harnessLayers: [
    ...CLAUDE_CODE_AMD64_RELEASE.harnessLayers,
    {
      harness: "Codex",
      harnessVersion: CODEX_VERSION,
      architecture: "Amd64",
      layerDigest: "7".repeat(64),
      manifestDigest: "8".repeat(64),
      sizeBytes: 65536,
    },
  ],
};

let certs: Server;
let github: Server;
let server: TestHarness;
let origin: string;
let issuer: string;
let scratch: string;
let tenants = 0;

const assertion = (email: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
  const payload = encode({ iss: issuer, aud: [AUDIENCE], email, iat: now, nbf: now, exp: now + 600 });
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rsa.privateKey).toString("base64url")}`;
};

const browser = (email: string): Record<string, string> => ({ "cf-access-jwt-assertion": assertion(email), origin });

const call = (path: string, init: NonNullable<Parameters<TestHarness["fetch"]>[1]> = {}) =>
  server.fetch(`${origin}${path}`, { redirect: "manual", ...init });

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

type Objects = {
  put(key: string, body: string | Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  text(key: string): Promise<string | null>;
};

const objects = (bucket: "STORE" | "RELEASES"): Objects => {
  const at = (key: string): string => `/__fixture/objects/${bucket}/${key}`;
  const written = async (response: { status: number; text(): Promise<string> }): Promise<void> => {
    assert.equal(response.status, 204, await response.text());
  };
  return {
    put: async (key, body) => written(await call(at(key), { method: "PUT", body })),
    delete: async (key) => written(await call(at(key), { method: "DELETE" })),
    text: async (key) => {
      const response = await call(at(key));
      if (response.status === 404) return null;
      assert.equal(response.status, 200, await response.clone().text());
      return response.text();
    },
  };
};

const store = objects("STORE");
const releases = objects("RELEASES");

const storeTimers = async (sessionId: string, timers: unknown, at: number): Promise<void> => {
  const response = await call(`/__fixture/timers/${sessionId}`, {
    method: "PUT",
    body: JSON.stringify({ timers, at }),
  });
  assert.equal(response.status, 204, await response.text());
};

const StoredTimersSchema = z.object({ deadlines: z.record(z.string(), z.unknown()) }).nullable();

const storedTimers = async (sessionId: string): Promise<z.infer<typeof StoredTimersSchema>> => {
  const response = await call(`/__fixture/timers/${sessionId}`);
  assert.equal(response.status, 200, await response.clone().text());
  return StoredTimersSchema.parse(await response.json());
};

const tenantSql = async (tenantId: string, query: string, ...bindings: (string | number)[]): Promise<unknown[]> => {
  const response = await call(`/__fixture/sql/${tenantId}`, {
    method: "POST",
    body: JSON.stringify({ query, bindings }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return z.array(z.unknown()).parse(await response.json());
};

const d1Run = async (query: string, ...bindings: (string | number)[]): Promise<void> => {
  const response = await call("/__fixture/d1", { method: "POST", body: JSON.stringify({ query, bindings }) });
  assert.equal(response.status, 204, await response.text());
};

let mcpId = 0;

const GITHUB_ISSUES: Record<string, { state: string; title: string; body: string }> = {
  "/repos/acme/app/issues/12": { state: "open", title: "Fix the login: it loops", body: "Steps: sign in" },
  "/repos/acme/app/issues/2": { state: "closed", title: "Done already", body: "" },
};

const GITHUB_TOKEN_PREFIX = "ghp-e2e-";
const userReads = new Map<string, number>();

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
    this.heartbeat = setInterval(() => this.beat(), SETTINGS.heartbeatIntervalSeconds * 1000);
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
    const deadline = Date.now() + GIVE_UP_MS;
    for (;;) {
      const at = this.inbox.findIndex((message) => message.type === type);
      if (at !== -1) return this.inbox.splice(at, 1)[0] as Extract<ControlMessage, { type: K }>;
      const left = deadline - Date.now();
      if (left <= 0) assert.fail(`no ${type} reached the host`);
      await Promise.race([
        new Promise<void>((resolve) => this.waiters.push(resolve)),
        wait(left, undefined, { ref: false }),
      ]);
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

const hostSides: HostSide[] = [];

const connect = async (...args: Parameters<typeof HostSide.connect>): Promise<HostSide> => {
  const side = await HostSide.connect(...args);
  hostSides.push(side);
  return side;
};

const connectorToken = async (tenantId: string, email: string): Promise<string> => {
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
      ...browser(email),
      "content-type": "application/x-www-form-urlencoded",
      cookie: `__Host-tumpel_connect=${csrf}`,
    },
    body: new URLSearchParams({
      request: consent.searchParams.get("request") ?? "",
      csrf,
      tenant: tenantId,
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const SETTINGS_FILE = '{"permissions":{"defaultMode":"bypassPermissions"}}';
const GITHUB_USER = { id: 4242, login: "ticket-worker" };
const PREBUILT_HEAD = "5".repeat(40);
const PREBUILT_TREE = "6".repeat(40);
const installationTokenRequests: unknown[] = [];

const prebuiltRepository = (method: string, path: string): { status: number; body: unknown } | null => {
  if (method === "POST" && path === "/app/installations/77/access_tokens") {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    return {
      status: 201,
      body: { token: "installation-token", expires_at: expiresAt, permissions: { contents: "read" } },
    };
  }
  if (path === "/repos/prebuilt/app") return { status: 200, body: { default_branch: "main" } };
  if (path === "/repos/prebuilt/app/commits/main") {
    return { status: 200, body: { sha: PREBUILT_HEAD, commit: { tree: { sha: PREBUILT_TREE } } } };
  }
  if (path === `/repos/prebuilt/app/git/trees/${PREBUILT_TREE}`) {
    return { status: 200, body: { tree: [{ path: "package-lock.json", type: "blob", sha: "7".repeat(40) }] } };
  }
  return null;
};

const installPrebuiltApp = async (tenantId: string): Promise<void> => {
  const keyStore = workersSecretKeyStore(Buffer.alloc(32, 7).toString("base64"));
  const dataKey = await generateDataKey();
  const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const privateKey = appKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  await d1Run(
    `INSERT INTO github_apps (github_app_slot, app_id, slug, client_id, owner_login, html_url, wrapped_data_key,
    client_secret_sealed, webhook_secret_sealed, private_key_sealed, bot_user_id, created_at)
    VALUES (1, 1, 'tumpel-sessions', 'Iv1.sessions', 'prebuilt', 'https://github.com/apps/tumpel-sessions', ?, ?, ?, ?, 4343, ?)`,
    await keyStore.wrap(dataKey),
    await seal(dataKey, "sessions-client-secret", "github-app/client_secret"),
    await seal(dataKey, "sessions-webhook-secret", "github-app/webhook_secret"),
    await seal(dataKey, privateKey, "github-app/private_key"),
    Date.now(),
  );
  await d1Run(
    `INSERT INTO github_installations (installation_id, tenant_id, account_login, account_type, status, created_at, updated_at)
    VALUES (77, ?, 'prebuilt', 'Organization', 'Active', ?, ?)`,
    tenantId,
    Date.now(),
    Date.now(),
  );
};

type Placement = { digest: string; packDigest: string; offset: number; length: number };

const CHUNK_BYTES = 10;

const placed = (packs: Record<string, string[]>): Placement[] =>
  Object.entries(packs).flatMap(([packDigest, digests]) =>
    digests.map((digest, index) => ({ digest, packDigest, offset: index * CHUNK_BYTES, length: CHUNK_BYTES })),
  );

const tenant = async () => {
  tenants += 1;
  const email = `sessions-${tenants}@example.test`;
  const github = `${GITHUB_TOKEN_PREFIX}${tenants}`;
  const signedUp = await postJson("/v1/tenants", { name: `Sessions ${tenants}` }, browser(email));
  assert.equal(signedUp.status, 200);
  const { tenantId } = WhoamiSchema.parse(await signedUp.json()).tenant;
  const mcpToken = await connectorToken(tenantId, email);
  const bearer = { authorization: `Bearer ${mcpToken}` };

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

  const tool = async <T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> => {
    mcpId += 1;
    const response = await postJson(
      "/mcp",
      { jsonrpc: "2.0", id: mcpId, method: "tools/call", params: { name, arguments: args } },
      bearer,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    const text = body.result.content[0]?.text ?? "";
    assert.equal(body.result.isError, undefined, `${name} failed: ${text}`);
    assert.equal(text.includes(PROVIDER_KEY), false, `${name} answered with the provider key`);
    return schema.parse(JSON.parse(text));
  };

  const toolRefusal = async (name: string, args: Record<string, unknown>): Promise<string> => {
    mcpId += 1;
    const response = await postJson(
      "/mcp",
      { jsonrpc: "2.0", id: mcpId, method: "tools/call", params: { name, arguments: args } },
      bearer,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    const text = body.result.content[0]?.text ?? "";
    assert.equal(body.result.isError, true, `${name} answered ${text}`);
    return text;
  };

  const enrol = async (name = "box"): Promise<{ id: string; key: KeyObject }> => {
    const minted = await postJson("/v1/enrolment-tokens", { expiresInSeconds: 600 }, bearer);
    const { token } = MintedEnrolmentTokenSchema.parse(await minted.json());
    const dir = mkdtempSync(join(scratch, `${name}-`));
    const tokenFile = `${dir}.token`;
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
        RawTranscriptPageSchema,
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
      repository: "https://github.com/acme/app.git",
      model: "claude-sonnet-test",
      personaId: personas.find((persona) => persona.name === name)?.personaId,
    };
  };

  const createPersona = async (name: string, secrets: unknown[], files: unknown[] = []): Promise<void> => {
    const created = await postJson("/v1/secret-sets", { name: `${name} secrets`, secrets }, bearer);
    assert.equal(created.status, 200);
    const { secretSetId } = SecretSetSchema.parse(await created.json());
    const persona = { name, harness: "ClaudeCode", secretSetId, files };
    const personas = await getJson("/v1/personas", PersonaSchema.array());
    const existing = personas.find((candidate) => candidate.name === name);
    const written = await server.fetch(`${origin}/v1/personas${existing ? `/${existing.personaId}` : ""}`, {
      method: existing ? "PUT" : "POST",
      headers: { "content-type": "application/json", ...bearer },
      body: JSON.stringify(persona),
    });
    assert.equal(written.status, 200);
  };

  const deletePersona = (personaId: string) => call(`/v1/personas/${personaId}`, { method: "DELETE", headers: bearer });

  const hostState = (id: string, state: string) =>
    until(
      `host ${id} reading ${state}`,
      () => getJson(`/v1/hosts/${id}`, HostSchema),
      (read) => read.state === state,
    );

  await createPersona(
    "Default",
    [
      { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: PROVIDER_KEY },
      { kind: "Variable", name: "GITHUB_TOKEN", value: github },
    ],
    [{ source: "Inline", path: ".claude/settings.json", content: Buffer.from(SETTINGS_FILE).toString("base64") }],
  );
  const enrolled = await enrol();
  const hostId = enrolled.id;
  const host = await connect(hostId, enrolled.key);
  await hostState(hostId, "Online");

  const completedTurn = async (prompt: string) => {
    const started = await tool("tumpel_session_start", { ...(await sessionStart()), prompt }, StartedSessionSchema);
    const offer = await host.next("TurnOffer");
    assert.equal(offer.sessionId, started.session.sessionId);
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: '{"type":"result"}' });
    host.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    return { session: started.session, offer };
  };

  const storedChunks = async (
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
    await until(
      "a stored snapshot",
      () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
      (snapshots) => snapshots.some((snapshot) => snapshot.outcome.state === "Stored"),
    );
    return { request, held: answer.held, uploaded: uploads.uploads.map((upload) => upload.packDigest) };
  };

  return {
    tenantId,
    github,
    reads: () => userReads.get(github) ?? 0,
    bearer,
    host,
    hostId,
    refused,
    getJson,
    tool,
    toolRefusal,
    enrol,
    readAll,
    sessionStart,
    createPersona,
    deletePersona,
    hostState,
    completedTurn,
    storedChunks,
  };
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
  github = createServer((request, response) => {
    const path = (request.url ?? "").toLowerCase();
    const prebuilt = prebuiltRepository(request.method ?? "", path);
    if (prebuilt !== null) {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        if (body !== "") installationTokenRequests.push(JSON.parse(body));
        response.writeHead(prebuilt.status, { "content-type": "application/json" });
        response.end(JSON.stringify(prebuilt.body));
      });
      return;
    }
    const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    const known = token.startsWith(GITHUB_TOKEN_PREFIX);
    if (path === "/user" && known) {
      userReads.set(token, (userReads.get(token) ?? 0) + 1);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(GITHUB_USER));
      return;
    }
    const issue = GITHUB_ISSUES[path];
    if (issue === undefined || !known) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ...issue,
        number: Number(path.split("/").at(-1)),
        html_url: `https://github.com${path.replace("/repos", "")}`,
        updated_at: "2026-11-15T09:00:00Z",
        labels: [],
      }),
    );
  });
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
  server = createTestHarness({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    workers: [
      {
        config: {
          ...config,
          main: "./test/fixtures/sessions-worker.ts",
          vars: {
            ...config.vars,
            ACCESS_ISSUER: issuer,
            ACCESS_AUD: AUDIENCE,
            TUMPEL_SETTINGS: SETTINGS,
            DEPLOYED_COMMIT,
            R2_STUB_ORIGIN,
            SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
            DASHBOARD_ORIGIN: "https://app.tumpel.test",
            GITHUB_API_ORIGIN: `http://127.0.0.1:${(github.address() as AddressInfo).port}`,
          },
        },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  await server.getWorker().applyD1Migrations("DB");
  await releases.put("current.json", JSON.stringify(RELEASE));
});

after(async () => {
  for (const side of hostSides) side.close();
  await server?.close();
  certs?.close();
  github?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("a start against a current.json of the previous shape is refused ImageNotReleased with the reason, not a crash", async () => {
  const { bearer, sessionStart } = await tenant();
  const { bases: _bases, ...previous } = RELEASE;
  await releases.put(
    "current.json",
    JSON.stringify({ ...previous, channelProtocolVersion: ChannelProtocol.Version - 1 }),
  );
  const refusal = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "old release" }, bearer);
  const problem = ProblemSchema.parse(await refusal.json());
  await releases.put("current.json", JSON.stringify(RELEASE));
  assert.equal(refusal.status, 422);
  assert.equal(problem.code, "ImageNotReleased");
  assert.match(problem.detail, /the published release is unreadable: current\.json .* bases/);
  assert.equal(problem.fix, "Ask the operator to publish a release with the release workflow, then start again");
});

test("a deploy drain refuses new sessions and turns DeployInProgress and counts each host's running turns until they end", async () => {
  const { bearer, host, hostId, getJson, sessionStart } = await tenant();
  const drainToken = randomBytes(32).toString("base64url");
  const drainBearer = { authorization: `Bearer ${drainToken}` };
  const report = async () => {
    const response = await call("/v1/releases/rollout", { headers: drainBearer });
    assert.equal(response.status, 200, await response.clone().text());
    return ReleaseRolloutSchema.parse(await response.json());
  };

  const idle = await call("/v1/releases/rollout", { headers: drainBearer });
  assert.equal(idle.status, 404);
  assert.equal(ProblemSchema.parse(await idle.json()).code, "NotFound");

  const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "before the drain" }, bearer);
  assert.equal(response.status, 200);
  const started = StartedSessionSchema.parse(await response.json());
  const offer = await host.next("TurnOffer");
  assert.equal(offer.turnId, started.turn.turnId);

  await releases.put("deploy-drain.json", JSON.stringify({ drainToken }));
  try {
    const wrong = await call("/v1/releases/rollout", { headers: bearer });
    assert.equal(wrong.status, 401);
    assert.equal(ProblemSchema.parse(await wrong.json()).code, "DeployDrainTokenRefused");

    assert.deepEqual(await report(), {
      deployedCommit: DEPLOYED_COMMIT,
      drained: false,
      hosts: [{ hostId, tenantId: started.session.tenantId, runningTurns: 1 }],
    });

    const start = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "during the drain" }, bearer);
    assert.equal(start.status, 503);
    const startRefusal = ProblemSchema.parse(await start.json());
    assert.equal(startRefusal.code, "DeployInProgress");
    assert.match(startRefusal.detail, /a deploy of the control plane is in progress/);
    assert.equal(startRefusal.fix, "Once the dashboard shows the new release, start again");

    await until(
      "the offered turn reading Failed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    assert.deepEqual(await report(), { deployedCommit: DEPLOYED_COMMIT, drained: true, hosts: [] });

    const send = await postJson(`/v1/sessions/${started.session.sessionId}/turns`, { prompt: "draining" }, bearer);
    assert.equal(send.status, 503);
    const sendRefusal = ProblemSchema.parse(await send.json());
    assert.equal(sendRefusal.code, "DeployInProgress");
    assert.equal(sendRefusal.fix, "Once the dashboard shows the new release, send the turn again");
  } finally {
    await releases.delete("deploy-drain.json");
  }
  assert.equal((await call("/v1/releases/rollout", { headers: drainBearer })).status, 404);
});

suite("sessions", { concurrency: 8 }, () => {
  test("a turn started over MCP reaches the host, its lines read back in order by cursor, and a snapshot follows", async () => {
    const { github, reads, host, hostId, getJson, tool, readAll, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "fix the build" },
      StartedSessionSchema,
    );
    assert.equal(started.session.hostId, hostId);
    assert.equal(started.turn.state, "Offered");
    const [usage] = await getJson("/v1/hosts/usage", ReportedHostUsageSchema.array());
    assert.deepEqual(
      { hostId: usage?.hostId, boxCapacity: usage?.boxCapacity, boxesRunning: usage?.boxesRunning },
      { hostId, boxCapacity: 8, boxesRunning: 1 },
    );

    const offer = await host.next("TurnOffer");
    assert.equal(offer.turnId, started.turn.turnId);
    assert.equal(offer.sessionId, started.session.sessionId);
    assert.equal(offer.prompt, "fix the build");
    assert.deepEqual(offer.credential.variables, [
      { name: "ANTHROPIC_API_KEY", value: PROVIDER_KEY },
      { name: "GITHUB_TOKEN", value: github },
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
    assert.match(
      offer.personaFiles[0]?.downloadUrl ?? "",
      new RegExp(`/persona-files/${digest}\\?X-Tumpel-Method=GET`),
    );
    assert.deepEqual(
      [offer.gitAuthorName, offer.gitAuthorEmail],
      ["ticket-worker", "4242+ticket-worker@users.noreply.github.com"],
    );
    assert.equal(reads(), 1, "the control plane reads the token's GitHub user once, when the secret set is written");
    const { image } = offer;
    assert.ok(image.kind === "Layered", "a release with a base and the harness layer boots layered");
    assert.deepEqual(
      [image.base.imageDigest, image.base.kernelDigest, image.base.manifestDigest, image.layer.layer.layerDigest],
      [BASE_DIGEST, KERNEL_DIGEST, BASE_MANIFEST_DIGEST, "1".repeat(64)],
    );
    const layers = `layers/ClaudeCode/${CLAUDE_CODE_VERSION}/amd64`;
    for (const [url, key] of [
      [image.base.imageUrl, `images/base/amd64/${BASE_DIGEST}`],
      [image.base.kernelUrl, `kernels/amd64/${KERNEL_DIGEST}`],
      [image.base.manifestUrl, `images/base/amd64/${BASE_MANIFEST_DIGEST}`],
      [image.layer.layerUrl, `${layers}/${"1".repeat(64)}`],
      [image.layer.manifestUrl, `${layers}/${"2".repeat(64)}`],
    ]) {
      assert.match(url ?? "", new RegExp(`^${R2_STUB_ORIGIN}/tumpel-releases/${key}\\?X-Tumpel-Method=GET`));
    }
    assert.equal(image.fetchSeconds, IMAGE_FETCH_BUDGET_SECONDS);
    assert.deepEqual(
      [offer.credential.expiresAt, offer.personaFiles[0]?.downloadExpiresAt],
      [offer.image.downloadExpiresAt, offer.image.downloadExpiresAt],
    );
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
    assert.ok(!JSON.stringify(handovers).includes(github));

    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    await until(
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
    await until(
      "three lines in the transcript",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.lineCount === 3,
    );
    assert.deepEqual(await readAll(sessionId, turnId, 10), expected);
    const chunked = await tool(
      "tumpel_transcript_read",
      { sessionId, compact: true, limit: 10 },
      CompactTranscriptPageSchema,
    );
    assert.equal(chunked.sessionId, sessionId);
    assert.deepEqual(chunked.turns, [
      {
        turnId,
        lines: [
          { lineSeq: 2, text: "on it" },
          { lineSeq: 3, text: "[Bash] npm test" },
        ],
      },
    ]);
    assert.equal(chunked.cursor, 3);
    assert.equal(chunked.finished, false);
    const pending = await tool(
      "tumpel_transcript_read",
      { sessionId, compact: true, limit: 10, after: 2 },
      CompactTranscriptPageSchema,
    );
    assert.deepEqual(pending.turns, [{ turnId, lines: [{ lineSeq: 3, text: "[Bash] npm test" }] }]);
    assert.equal(pending.cursor, 3);
    assert.equal(pending.finished, false);

    host.send({ type: "TurnComplete", turnId, lastLineSeq: 3, completedAt: new Date().toISOString() });
    const completed = await until(
      "the turn reading Completed",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Completed",
    );
    assert.equal(completed.lineCount, 3);
    assert.deepEqual(await readAll(sessionId, turnId, 10), expected);
    assert.deepEqual(await readAll(sessionId, turnId, 1), expected);
    const first = await tool("tumpel_transcript_read", { sessionId, limit: 1 }, RawTranscriptPageSchema);
    assert.equal(first.cursor, 1);
    assert.equal(first.finished, false);
    const last = await tool("tumpel_transcript_read", { sessionId, after: 2 }, RawTranscriptPageSchema);
    assert.equal(last.cursor, 3);
    assert.equal(last.finished, true);
    const pastDropped = await tool(
      "tumpel_transcript_read",
      { sessionId, compact: true, limit: 1 },
      CompactTranscriptPageSchema,
    );
    assert.deepEqual(pastDropped.turns, [{ turnId, lines: [{ lineSeq: 2, text: "on it" }] }]);
    assert.equal(pastDropped.cursor, 2);

    const request = await host.next("SnapshotRequest");
    assert.equal(request.sessionId, sessionId);
    assert.equal(request.turnId, turnId);
    assert.equal(request.snapshotSeq, 1);
    const upload = new URL(request.uploadUrl);
    assert.equal(upload.origin, R2_STUB_ORIGIN);
    assert.equal(upload.pathname, `/tumpel-sessions/${request.storageKey}`);
    assert.equal(upload.searchParams.get("X-Tumpel-Method"), "PUT");
    assert.ok(Date.parse(request.uploadExpiresAt) > Date.now());
    await store.put(request.storageKey, '{"entries":[]}');
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 4096 });
    const [snapshot] = await until(
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
  });

  test("a turn whose lines arrive up to its completion reads back whole in one page that reads finished", async () => {
    const { github, host, tool, toolRefusal, sessionStart, createPersona } = await tenant();
    await createPersona("Tail", [
      { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: PROVIDER_KEY },
      { kind: "Variable", name: "GITHUB_TOKEN", value: github },
    ]);
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart("Tail")), prompt: "write a long tail" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    await until(
      "the turn reading Running",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );
    const texts = Array.from({ length: 7 }, (_, index) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `line ${index + 1}` }] } }),
    );
    texts.forEach((text, index) => {
      host.send({ type: "TurnLine", turnId, lineSeq: index + 1, text });
    });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: texts.length, completedAt: new Date().toISOString() });
    const completed = await until(
      "the turn reading Completed",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Completed",
    );
    assert.equal(completed.lineCount, texts.length);
    const raw = await tool("tumpel_transcript_read", { sessionId, turnId, limit: 100 }, RawTranscriptPageSchema);
    assert.deepEqual(
      raw.lines.map(({ lineSeq, text }) => ({ lineSeq, text })),
      texts.map((text, index) => ({ lineSeq: index + 1, text })),
    );
    assert.equal(raw.cursor, texts.length);
    assert.equal(raw.finished, true);
    const compact = await tool(
      "tumpel_transcript_read",
      { sessionId, turnId, compact: true, limit: 100 },
      CompactTranscriptPageSchema,
    );
    assert.deepEqual(
      compact.turns.flatMap((turn) => turn.lines.map((line) => line.lineSeq)),
      texts.map((_, index) => index + 1),
    );
    assert.equal(compact.finished, true);

    const request = await host.next("SnapshotRequest");
    assert.equal(request.sessionId, sessionId);
    await store.put(request.storageKey, '{"entries":[]}');
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 4096 });

    await tenantSql(
      started.session.tenantId,
      "UPDATE sessions SET harness = 'MistralAgent' WHERE session_id = ?",
      sessionId,
    );
    assert.match(
      await toolRefusal("tumpel_transcript_read", { sessionId, compact: true }),
      /runs MistralAgent, whose transcript has no compact form; ClaudeCode, Codex, OpenCode, PiDev have one/,
    );
  });

  test("lines that arrive during a slow chunk write go into the next chunk, and every line is stored once in order", async () => {
    const tenantId = `ten_${randomBytes(6).toString("hex")}`;
    const sessionId = "ses_serial";
    const turnId = "trn_serial";
    const pending: TranscriptLine[] = [];
    const index: { storageKey: string; lineSeqs: number[] }[] = [];
    const ledger: ChunkLedger = {
      pending: () => [...pending],
      record: (_sessionId, _turnId, storageKey, chunk) => {
        const last = chunk.lineSeqs.at(-1) ?? 0;
        pending.splice(0, pending.filter((line) => line.lineSeq <= last).length);
        index.push({ storageKey, lineSeqs: chunk.lineSeqs });
      },
    };
    const puts: string[] = [];
    const writing = signal();
    const held = signal();
    const spied: ChunkStore = {
      put: async (key, body) => {
        puts.push(key);
        if (puts.length === 1) {
          writing.resolve();
          await held.promise;
        }
        return store.put(key, body);
      },
    };
    const writer = new ChunkWriter(ledger, spied);
    const writes: Promise<void>[] = [];
    const deliver = (lineSeq: number): void => {
      pending.push({ sessionId, lineSeq, tenantId, turnId, text: `line ${lineSeq}`, createdAt: Date.now() });
      if (pending.length >= 2) writes.push(writer.write(tenantId, sessionId, turnId, 2));
    };
    deliver(1);
    deliver(2);
    await writing.promise;
    deliver(3);
    deliver(4);
    deliver(5);
    writes.push(writer.write(tenantId, sessionId, turnId, 1));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(puts.length, 1);
    held.resolve();
    await Promise.all(writes);
    assert.deepEqual(
      index.map((entry) => entry.lineSeqs),
      [
        [1, 2],
        [3, 4, 5],
      ],
    );
    assert.deepEqual(pending, []);
    const stored = await Promise.all(
      index.map(async ({ storageKey }) => {
        const text = await store.text(storageKey);
        assert.ok(text !== null, `chunk ${storageKey} is stored`);
        return decodeLines(text);
      }),
    );
    assert.deepEqual(
      stored.flat().map(({ lineSeq, text }) => ({ lineSeq, text })),
      [1, 2, 3, 4, 5].map((lineSeq) => ({ lineSeq, text: `line ${lineSeq}` })),
    );
  });

  test("a compact read stops after eight chunk reads of dropped lines, and the next read goes on from its cursor", async () => {
    const { github, host, tool, sessionStart, createPersona } = await tenant();
    await createPersona("Quiet", [
      { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: PROVIDER_KEY },
      { kind: "Variable", name: "GITHUB_TOKEN", value: github },
    ]);
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart("Quiet")), prompt: "think quietly" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    await until(
      "the turn reading Running",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );
    const dropped = Array.from({ length: 18 }, () => JSON.stringify({ type: "system", subtype: "status" }));
    const kept = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done thinking" }] } });
    [...dropped, kept].forEach((text, index) => {
      host.send({ type: "TurnLine", turnId, lineSeq: index + 1, text });
    });
    await until(
      "nineteen lines in the transcript",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.lineCount === 19,
    );
    const capped = await tool(
      "tumpel_transcript_read",
      { sessionId, compact: true, limit: 2 },
      CompactTranscriptPageSchema,
    );
    assert.deepEqual(capped.turns, []);
    assert.equal(capped.cursor, 16, "eight reads of two lines each, then the page answers");
    assert.equal(capped.finished, false);
    const next = await tool(
      "tumpel_transcript_read",
      { sessionId, compact: true, limit: 2, after: capped.cursor },
      CompactTranscriptPageSchema,
    );
    assert.deepEqual(next.turns, [{ turnId, lines: [{ lineSeq: 19, text: "done thinking" }] }]);
    assert.equal(next.cursor, 19);

    host.send({ type: "TurnComplete", turnId, lastLineSeq: 19, completedAt: new Date().toISOString() });
    const request = await host.next("SnapshotRequest");
    assert.equal(request.sessionId, sessionId);
    await store.put(request.storageKey, '{"entries":[]}');
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 4096 });
  });

  test("a setup box token writes its own setup's member once, only while the setup is Minting, and a second start on a set supersedes its running setup", async () => {
    const { github, bearer, host, getJson } = await tenant();
    const createSet = async (name: string) => {
      const created = await postJson(
        "/v1/secret-sets",
        { name, secrets: [{ kind: "Variable", name: "GITHUB_TOKEN", value: github }] },
        bearer,
      );
      assert.equal(created.status, 200, await created.clone().text());
      return SecretSetSchema.parse(await created.json()).secretSetId;
    };
    const secretSetId = await createSet("Claude setup secrets");
    const otherSetId = await createSet("Other Claude setup secrets");
    const startSetup = async (setId = secretSetId) => {
      const response = await postJson("/v1/claude-setups", { secretSetId: setId }, bearer);
      assert.equal(response.status, 200, await response.clone().text());
      const setup = ClaudeSetupSchema.parse(await response.json());
      const offer = await host.next("ClaudeSetupBoxOffer");
      assert.equal(offer.claudeSetupId, setup.claudeSetupId);
      return offer;
    };
    const first = await startSetup();
    const second = await startSetup(otherSetId);
    const token = "setup-e2e-subscription-token";
    const write = (claudeSetupId: string, credential: string, tenantId = first.tenantId) =>
      postJson(
        `/v1/claude-setups/${claudeSetupId}/token`,
        { tenantId, value: token },
        { authorization: `Bearer ${credential}` },
      );
    const status = (claudeSetupId: string) => getJson(`/v1/claude-setups/${claudeSetupId}`, ClaudeSetupSchema);

    assert.equal(
      (await write(first.claudeSetupId, first.tokenCredential)).status,
      409,
      "a Starting setup takes no token",
    );

    host.send({
      type: "ClaudeSetupBoxUrl",
      claudeSetupId: first.claudeSetupId,
      signInUrl: "https://claude.ai/oauth/authorize?state=e2e",
    });
    await until(
      "the setup reading AwaitingCode",
      () => status(first.claudeSetupId),
      (setup) => setup.status.state === "AwaitingCode",
    );
    assert.equal(
      (await write(first.claudeSetupId, first.tokenCredential)).status,
      409,
      "an AwaitingCode setup takes no token",
    );
    const coded = await postJson(`/v1/claude-setups/${first.claudeSetupId}/code`, { code: "e2e-code" }, bearer);
    assert.equal(coded.status, 200, await coded.clone().text());
    assert.equal((await host.next("ClaudeSetupBoxCode")).claudeSetupId, first.claudeSetupId);

    for (const [credential, tenantId, what] of [
      [second.tokenCredential, first.tenantId, "another setup's token"],
      [first.tokenCredential, crypto.randomUUID(), "the token under another tenant"],
    ] as const) {
      const refusal = await write(first.claudeSetupId, credential, tenantId);
      assert.equal(refusal.status, 401, `${what}: ${await refusal.clone().text()}`);
      assert.equal(ProblemSchema.parse(await refusal.json()).code, "ClaudeSetupBoxTokenRefused");
    }
    assert.equal((await status(first.claudeSetupId)).status.state, "Minting");

    const stored = await write(first.claudeSetupId, first.tokenCredential);
    assert.equal(stored.status, 204, await stored.clone().text());
    const again = await write(first.claudeSetupId, first.tokenCredential);
    assert.equal(again.status, 409, "a second write is refused");
    assert.equal(ProblemSchema.parse(await again.json()).code, "ClaudeSetupNotWaiting");

    const completed = await status(first.claudeSetupId);
    assert.equal(completed.status.state, "Completed");
    assert.equal(JSON.stringify(completed).includes(token), false);
    const set = await getJson(`/v1/secret-sets/${secretSetId}`, SecretSetSchema);
    assert.deepEqual(
      set.keys.map((key) => ({ kind: key.kind, name: key.name })).toSorted((a, b) => a.name.localeCompare(b.name)),
      [
        { kind: "SubscriptionToken", name: "CLAUDE_CODE_OAUTH_TOKEN" },
        { kind: "Variable", name: "GITHUB_TOKEN" },
      ],
    );

    const third = await startSetup(otherSetId);
    const superseded = await status(second.claudeSetupId);
    assert.ok(superseded.status.state === "Failed" && superseded.status.reason === "Superseded");
    assert.equal((await host.next("ClaudeSetupBoxDiscard")).claudeSetupId, second.claudeSetupId);
    assert.deepEqual(
      (await getJson(`/v1/claude-setups?secretSetId=${otherSetId}`, ClaudeSetupSchema.array())).map(
        (setup) => setup.claudeSetupId,
      ),
      [third.claudeSetupId],
    );
    host.send({
      type: "ClaudeSetupBoxFailed",
      claudeSetupId: third.claudeSetupId,
      reason: "SetupUrlMissing",
      detail: "the e2e leaves this setup",
      failedAt: new Date().toISOString(),
    });
  });

  test("a Codex sign-in stores its auth.json as a credential file, a turn gets it as a file, and a file the turn rewrote replaces it", async () => {
    const { bearer, host, getJson, github, tool } = await tenant();
    const created = await postJson(
      "/v1/secret-sets",
      { name: "Codex sign-in secrets", secrets: [{ kind: "Variable", name: "GITHUB_TOKEN", value: github }] },
      bearer,
    );
    assert.equal(created.status, 200, await created.clone().text());
    const { secretSetId } = SecretSetSchema.parse(await created.json());
    const started = await postJson("/v1/claude-setups", { secretSetId, harness: "Codex" }, bearer);
    assert.equal(started.status, 200, await started.clone().text());
    assert.equal(ClaudeSetupSchema.parse(await started.json()).harness, "Codex");
    const offer = await host.next("ClaudeSetupBoxOffer");
    assert.equal(offer.harnessVersion, CODEX_VERSION);
    const { claudeSetupId } = offer;
    const status = () => getJson(`/v1/claude-setups/${claudeSetupId}`, ClaudeSetupSchema);
    host.send({
      type: "ClaudeSetupBoxUrl",
      claudeSetupId,
      signInUrl: "https://auth.openai.com/codex/device",
      userCode: "K7QD-3MZP9",
    });
    const waiting = await until(
      "the setup reading AwaitingCode",
      status,
      (setup) => setup.status.state === "AwaitingCode",
    );
    assert.ok(waiting.status.state === "AwaitingCode" && waiting.status.userCode === "K7QD-3MZP9");
    const coded = await postJson(`/v1/claude-setups/${claudeSetupId}/code`, { code: "codex-code" }, bearer);
    assert.equal(coded.status, 409, "a Codex sign-in takes no submitted code");
    assert.equal(ProblemSchema.parse(await coded.json()).code, "ClaudeSetupNotWaiting");
    const expiresAt = "2026-12-01T10:00:00.000Z";
    const authFile = (exp: number) =>
      JSON.stringify({
        tokens: {
          access_token: `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`,
          refresh_token: `codex-e2e-refresh-${exp}`,
        },
      });
    const token = authFile(Date.parse(expiresAt) / 1000);
    const stored = await postJson(
      `/v1/claude-setups/${claudeSetupId}/token`,
      { tenantId: offer.tenantId, value: token, expiresAt },
      { authorization: `Bearer ${offer.tokenCredential}` },
    );
    assert.equal(stored.status, 204, await stored.clone().text());
    const completed = await status();
    assert.ok(completed.status.state === "Completed");
    assert.equal(completed.status.memberName, "CODEX_AUTH_JSON");
    assert.equal(completed.status.expiresAt, expiresAt);
    assert.equal(JSON.stringify(completed).includes(token), false);
    const keys = async () =>
      (await getJson(`/v1/secret-sets/${secretSetId}`, SecretSetSchema)).keys
        .map((key) => ({ kind: key.kind, name: key.name, expiresAt: "expiresAt" in key ? key.expiresAt : null }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(await keys(), [
      { kind: "CredentialFile", name: "CODEX_AUTH_JSON", expiresAt },
      { kind: "Variable", name: "GITHUB_TOKEN", expiresAt: null },
    ]);

    const persona = await postJson("/v1/personas", { name: "Codex", harness: "Codex", secretSetId, files: [] }, bearer);
    assert.equal(persona.status, 200, await persona.clone().text());
    const { personaId } = PersonaSchema.parse(await persona.json());
    await tool(
      "tumpel_session_start",
      { repository: "https://github.com/acme/app.git", model: "gpt-test", personaId, prompt: "refresh" },
      StartedSessionSchema,
    );
    const turn = await host.next("TurnOffer");
    assert.deepEqual(turn.credential.credentialFile, { path: ".codex/auth.json", value: token });
    assert.equal(
      turn.credential.variables.some((variable) => variable.value === token),
      false,
      "the login file is never a variable",
    );
    host.send({ type: "TurnClaim", turnId: turn.turnId, boxId: turn.boxId });
    const refreshedAt = "2026-12-02T10:00:00.000Z";
    host.send({
      type: "TurnComplete",
      turnId: turn.turnId,
      lastLineSeq: 0,
      completedAt: new Date().toISOString(),
      credentialFile: authFile(Date.parse(refreshedAt) / 1000),
    });
    await until("the secret set holding the rewritten file", keys, (read) => read[0]?.expiresAt === refreshedAt);
  });

  test("a box whose Claude Code mints no token within the code's mint budget is waited on past that budget and fails SetupTimedOut when its box says so", async () => {
    const { bearer, host, getJson } = await tenant();
    const created = await postJson("/v1/secret-sets", { name: "Mint budget secrets", secrets: [] }, bearer);
    assert.equal(created.status, 200, await created.clone().text());
    const { secretSetId } = SecretSetSchema.parse(await created.json());
    const started = await postJson("/v1/claude-setups", { secretSetId }, bearer);
    assert.equal(started.status, 200, await started.clone().text());
    const { claudeSetupId } = await host.next("ClaudeSetupBoxOffer");
    const status = () => getJson(`/v1/claude-setups/${claudeSetupId}`, ClaudeSetupSchema);
    host.send({ type: "ClaudeSetupBoxUrl", claudeSetupId, signInUrl: "https://claude.ai/oauth/authorize?state=mint" });
    await until("the setup reading AwaitingCode", status, (setup) => setup.status.state === "AwaitingCode");
    const codedAt = Date.now();
    const coded = await postJson(`/v1/claude-setups/${claudeSetupId}/code`, { code: "mint-code" }, bearer);
    assert.equal(coded.status, 200, await coded.clone().text());
    const minting = ClaudeSetupSchema.parse(await coded.json());
    assert.ok(minting.status.state === "Minting");
    assert.ok(
      Date.parse(minting.status.tokenDueAt) >=
        codedAt + (SETTINGS.claudeSetupMintBudgetSeconds + SETTINGS.claudeSetupMintGraceSeconds) * 1000,
      "the control plane waits past the box's own mint budget",
    );
    const code = await host.next("ClaudeSetupBoxCode");
    assert.equal(code.mintBudgetSeconds, SETTINGS.claudeSetupMintBudgetSeconds);
    host.send({
      type: "ClaudeSetupBoxFailed",
      claudeSetupId,
      reason: "SetupTimedOut",
      detail: "Claude Code minted no token within mintBudgetSeconds 120 of the code",
      failedAt: new Date().toISOString(),
    });
    const failed = await until("the setup reading Failed", status, (setup) => setup.status.state === "Failed");
    assert.ok(failed.status.state === "Failed" && failed.status.reason === "SetupTimedOut");
    assert.deepEqual(await getJson(`/v1/claude-setups?secretSetId=${secretSetId}`, ClaudeSetupSchema.array()), []);
  });

  test("a Minting setup whose box says nothing lists as the one to resume, and listed or read past the host deadline fails SetupTimedOut and discards its box even when its alarm never fired", async () => {
    const { bearer, host, getJson } = await tenant();
    const created = await postJson("/v1/secret-sets", { name: "Silent setup secrets", secrets: [] }, bearer);
    assert.equal(created.status, 200, await created.clone().text());
    const { secretSetId } = SecretSetSchema.parse(await created.json());
    const started = await postJson("/v1/claude-setups", { secretSetId }, bearer);
    assert.equal(started.status, 200, await started.clone().text());
    const offer = await host.next("ClaudeSetupBoxOffer");
    const { claudeSetupId, tenantId } = offer;
    const status = () => getJson(`/v1/claude-setups/${claudeSetupId}`, ClaudeSetupSchema);
    host.send({
      type: "ClaudeSetupBoxUrl",
      claudeSetupId,
      signInUrl: "https://claude.ai/oauth/authorize?state=silent",
    });
    await until("the setup reading AwaitingCode", status, (setup) => setup.status.state === "AwaitingCode");
    const coded = await postJson(`/v1/claude-setups/${claudeSetupId}/code`, { code: "silent-code" }, bearer);
    assert.equal(coded.status, 200, await coded.clone().text());
    await host.next("ClaudeSetupBoxCode");
    const listed = () => getJson(`/v1/claude-setups?secretSetId=${secretSetId}`, ClaudeSetupSchema.array());
    assert.deepEqual(
      (await listed()).map((setup) => [setup.claudeSetupId, setup.status.state]),
      [[claudeSetupId, "Minting"]],
    );
    await tenantSql(
      tenantId,
      "UPDATE claude_setups SET phase_due_at = ? WHERE claude_setup_id = ?",
      Date.now() - 1,
      claudeSetupId,
    );
    assert.deepEqual(await listed(), []);
    const read = await status();
    assert.ok(read.status.state === "Failed" && read.status.reason === "SetupTimedOut");
    assert.match(
      read.status.detail,
      /reported nothing within claudeSetupMintBudgetSeconds 120 plus claudeSetupMintGraceSeconds 10 of the code; check that the host is online/,
    );
    assert.equal((await host.next("ClaudeSetupBoxDiscard")).claudeSetupId, claudeSetupId);
    const late = await postJson(
      `/v1/claude-setups/${claudeSetupId}/token`,
      { tenantId, value: "overdue-subscription-token" },
      { authorization: `Bearer ${offer.tokenCredential}` },
    );
    assert.equal(late.status, 409, await late.clone().text());
    assert.equal(ProblemSchema.parse(await late.json()).code, "ClaudeSetupNotWaiting");
  });

  test("a stop snapshots an idle session and frees its box, and an archive deletes its snapshots, keeps its transcript and refuses later sends, and its persona stays", async () => {
    const { github, host, refused, tool, readAll, sessionStart, createPersona, deletePersona } = await tenant();
    await createPersona("Archivable", [
      { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: PROVIDER_KEY },
      { kind: "Variable", name: "GITHUB_TOKEN", value: github },
    ]);
    const start = await sessionStart("Archivable");
    const started = await tool("tumpel_session_start", { ...start, prompt: "stop me" }, StartedSessionSchema);
    const { sessionId } = started.session;
    assert.equal(started.session.lastTurnId, started.turn.turnId);
    assert.equal(started.session.lastTurnState, "Offered");
    assert.equal(Date.parse(started.session.lastTurnAt), started.turn.updatedAt);
    const offer = await host.next("TurnOffer");
    assert.equal(offer.sessionId, sessionId);
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    await until(
      "the turn reading Running",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );
    const inFlight = await refused(`/v1/sessions/${sessionId}/stop`);
    assert.equal(inFlight.code, "TurnInFlight");
    assert.match(inFlight.detail, new RegExp(turnId));

    host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result"}' });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    await until(
      "the turn reading Completed",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Completed",
    );
    const completed = await tool("tumpel_turn_get", { turnId }, TurnSchema);
    const got = await tool("tumpel_session_get", { sessionId }, SessionSchema);
    const [listed] = (await tool("tumpel_session_list", {}, SessionSchema.array())).filter(
      (session) => session.sessionId === sessionId,
    );
    for (const session of [got, listed]) {
      assert.equal(session?.lastTurnId, turnId);
      assert.equal(session?.lastTurnState, "Completed");
      assert.equal(session?.lastTurnAt, new Date(completed.updatedAt).toISOString());
    }
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
    await until(
      "the session reading Stopped",
      () => tool("tumpel_session_get", { sessionId }, SessionSchema),
      (session) => session.state === "Stopped",
    );

    const inUse = await deletePersona(start.personaId ?? "");
    assert.equal(inUse.status, 409);
    assert.match(
      ProblemSchema.parse(await inUse.json()).detail,
      new RegExp(`persona ${start.personaId} is the persona of session ${sessionId}, which is not Failed$`),
    );

    const archived = await tool("tumpel_session_archive", { sessionId }, SessionSchema);
    assert.equal(archived.state, "Archived");
    assert.equal(await store.text(request.storageKey), null);
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
    const { host, getJson, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "keep my box" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result"}' });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    const warm = await host.next("SnapshotRequest");
    await store.put(warm.storageKey, '{"entries":[]}');
    host.send({ type: "SnapshotDone", snapshotId: warm.snapshotId, uploadedBytes: 14 });
    await until(
      "a stored snapshot",
      () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
      (snapshots) => snapshots.length === 1,
    );

    await tool("tumpel_session_stop", { sessionId }, SessionSchema);
    const teardown = await host.next("BoxTeardown");
    const failedAt = new Date().toISOString();
    const detail = `box ${teardown.boxId} holds turn ${turnId}, which no snapshot holds; snapshot it, then tear it down`;
    host.send({ type: "BoxTeardownFailed", sessionId, boxId: teardown.boxId, reason: "BoxDirty", detail, failedAt });
    const idle = await until(
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
    await until(
      "a second stored snapshot",
      () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
      (snapshots) => snapshots.length === 2,
    );
  });

  test("a stop whose snapshot fails returns the session to Idle and does not ask for that snapshot again", async () => {
    const { host, getJson, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "fail my snapshot" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
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
    await until(
      "the session reading Idle",
      () => getJson(`/v1/sessions/${sessionId}`, SessionSchema),
      (session) => session.state === "Idle",
    );

    const timers = await storedTimers(sessionId);
    assert.equal(timers?.deadlines.Snapshot, undefined);
    assert.equal(host.snapshotRequestsFor(sessionId), 0);
  });

  test("a snapshot learns where the tenant holds its chunks and uploads only new packs, a restore gets only its session's packs, and an archive deletes the packs no live chunk lies in", async () => {
    const { host, getJson, tool, completedTurn, storedChunks } = await tenant();
    const [one, two, three] = ["1", "2", "3"].map((digit) => digit.repeat(64)) as [string, string, string];
    const [packOne, packTwo, packThree] = ["a", "b", "c"].map((digit) => digit.repeat(64)) as [string, string, string];
    const first = await completedTurn("chunk the first");
    const { request, held, uploaded } = await storedChunks(first.session.sessionId, [one, two], {
      [packOne]: [one],
      [packTwo]: [two],
    });
    assert.deepEqual(held, []);
    assert.deepEqual(uploaded, [packOne, packTwo]);
    const tenantId = request.storageKey.split("/")[0] ?? "";

    const second = await completedTurn("chunk the second");
    const shared = await storedChunks(second.session.sessionId, [two, three, three], { [packThree]: [three] });
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
    await until(
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
    await until(
      "the unclaimed shared restore turn reading Failed",
      () => getJson(`/v1/turns/${reusing.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );

    await tool("tumpel_session_stop", { sessionId: first.session.sessionId }, SessionSchema);
    const teardown = await host.next("BoxTeardown");
    host.send({ type: "BoxGone", sessionId: first.session.sessionId, boxId: teardown.boxId });
    await until(
      "the session reading Stopped",
      () => tool("tumpel_session_get", { sessionId: first.session.sessionId }, SessionSchema),
      (session) => session.state === "Stopped",
    );
    await tool("tumpel_session_archive", { sessionId: first.session.sessionId }, SessionSchema);
    assert.equal(await store.text(`${tenantId}/packs/${packOne}`), null);
    assert.notEqual(await store.text(`${tenantId}/packs/${packTwo}`), null);
    assert.notEqual(await store.text(`${tenantId}/packs/${packThree}`), null);

    const third = await completedTurn("chunk the third");
    const again = await storedChunks(third.session.sessionId, [one, two], { [packOne]: [one] });
    assert.deepEqual(
      again.held.map((placement) => placement.digest),
      [two],
    );
    assert.deepEqual(again.uploaded, [packOne]);
  });

  test("a turn the host never claims fails NotClaimed once the claim budget runs out", async () => {
    const { bearer, host, getJson, sessionStart } = await tenant();
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "never claimed" }, bearer);
    assert.equal(response.status, 200);
    const started = StartedSessionSchema.parse(await response.json());
    const offer = await host.next("TurnOffer");
    assert.equal(offer.turnId, started.turn.turnId);

    const failed = await until(
      "the turn reading Failed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    assert.ok(failed.updatedAt - started.turn.createdAt >= CLAIM_BUDGET_SECONDS * 1000);
    const failure = await getJson(`/v1/turns/${offer.turnId}/failure`, TurnFailureSchema);
    assert.equal(failure.reason, "NotClaimed");
    assert.match(failure.detail, new RegExp(`did not claim the turn within ${CLAIM_BUDGET_SECONDS} seconds`));
    assert.doesNotMatch(failure.detail, UUID);
  });

  test("a session timer stored before its owner field was dropped still fails an unclaimed turn NotClaimed", async () => {
    const { bearer, host, getJson, sessionStart } = await tenant();
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "stored timer" }, bearer);
    assert.equal(response.status, 200);
    const started = StartedSessionSchema.parse(await response.json());
    const offer = await host.next("TurnOffer");
    const { sessionId, tenantId } = started.session;
    const at = Date.now() + 500;
    await storeTimers(sessionId, { tenantId, sessionId, deadlines: { Claim: { turnId: offer.turnId, at } } }, at);

    await until(
      "the turn reading Failed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    const failure = await getJson(`/v1/turns/${offer.turnId}/failure`, TurnFailureSchema);
    assert.equal(failure.reason, "NotClaimed");
  });

  test("a start from an issue over MCP refuses a missing or closed issue, and an open one saves the issue and offers its prompt", async () => {
    const { bearer, host, tool, toolRefusal, sessionStart } = await tenant();
    const { personaId, model } = await sessionStart();
    const fromIssue = { personaId, model, owner: "Acme", name: "App" };

    assert.match(
      await toolRefusal("tumpel_session_start_from_issue", { ...fromIssue, issueNumber: 404 }),
      /^No such issue: https:\/\/github\.com\/acme\/app\/issues\/404 does not exist/,
    );
    const missing = await postJson("/v1/sessions/from-issue", { ...fromIssue, issueNumber: 404 }, bearer);
    assert.equal(missing.status, 404);
    assert.equal(ProblemSchema.parse(await missing.json()).code, "IssueNotFound");
    assert.match(
      await toolRefusal("tumpel_session_start_from_issue", { ...fromIssue, issueNumber: 2 }),
      /^Issue not open: https:\/\/github\.com\/acme\/app\/issues\/2 is a closed issue/,
    );

    const started = await tool(
      "tumpel_session_start_from_issue",
      { ...fromIssue, issueNumber: 12 },
      StartedSessionFromIssueSchema,
    );
    const { sessionId, tenantId } = started.session;
    assert.equal(started.session.repository, "https://github.com/acme/app");
    const issue = {
      sessionId,
      issueNumber: 12,
      title: "Fix the login: it loops",
      htmlUrl: "https://github.com/acme/app/issues/12",
      branch: "ticket/12-fix-the-login-it-loops",
    };
    assert.deepEqual(started.issue, issue);

    const offer = await host.next("TurnOffer");
    assert.equal(offer.turnId, started.turn.turnId);
    assert.ok(offer.prompt.includes(`Closes ${issue.htmlUrl}`));

    assert.deepEqual(
      await tenantSql(
        tenantId,
        "SELECT session_id, issue_number, title, html_url, branch FROM session_issues WHERE session_id = ?",
        sessionId,
      ),
      [{ session_id: sessionId, issue_number: 12, title: issue.title, html_url: issue.htmlUrl, branch: issue.branch }],
    );
  });

  test("a turn without a GitHub credential fails RepositoryTokenRefused before an offer, and a GITHUB_TOKEN GitHub refuses is refused at the write", async () => {
    const { bearer, getJson, sessionStart, createPersona } = await tenant();
    const stale = await postJson(
      "/v1/secret-sets",
      { name: "Stale secrets", secrets: [{ kind: "Variable", name: "GITHUB_TOKEN", value: "ghp-stale" }] },
      bearer,
    );
    assert.equal(stale.status, 400);
    const refusal = ProblemSchema.parse(await stale.json());
    assert.equal(refusal.code, "InvalidRequest");
    assert.match(refusal.detail, /member GITHUB_TOKEN: GitHub answered GET \S+\/user with 404/);
    assert.ok(!JSON.stringify(refusal).includes("ghp-stale"));

    await createPersona("NoGithub", [
      { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: PROVIDER_KEY },
    ]);
    const response = await postJson(
      "/v1/sessions",
      { ...(await sessionStart("NoGithub")), prompt: "no token" },
      bearer,
    );
    assert.equal(response.status, 200);
    const { turn } = StartedSessionSchema.parse(await response.json());
    await until(
      "the turn reading Failed",
      () => getJson(`/v1/turns/${turn.turnId}`, TurnSchema),
      (read) => read.state === "Failed",
    );
    const failure = await getJson(`/v1/turns/${turn.turnId}/failure`, TurnFailureSchema);
    assert.equal(failure.reason, "RepositoryTokenRefused");
    assert.match(failure.detail, /holds no GITHUB_TOKEN/);
  });

  test("a start refuses a repository in no accepted form and stores the accepted forms as the GitHub URL", async () => {
    const { bearer, host, tool, sessionStart } = await tenant();
    const start = { ...(await sessionStart()), prompt: "which repository" };
    for (const repository of ["acme", "github.com:acme/app", "https://gitlab.com/acme/app", "acme/app/tree/main"]) {
      const refusal = await postJson("/v1/sessions", { ...start, repository }, bearer);
      assert.equal(refusal.status, 422, repository);
      const problem = ProblemSchema.parse(await refusal.json());
      assert.equal(problem.title, "Not a GitHub repository");
      assert.equal(problem.fix, "Pass https://github.com/owner/name");
    }
    const started = await tool(
      "tumpel_session_start",
      { ...start, repository: "github.com/Acme/App.git" },
      StartedSessionSchema,
    );
    assert.equal(started.session.repository, "https://github.com/acme/app");
    const offer = await host.next("TurnOffer");
    assert.equal(offer.repository, "https://github.com/acme/app");
  });

  test("a clone failure fails the session, which takes no more turns, frees its persona for a delete and archives", async () => {
    const { github, bearer, host, refused, getJson, tool, sessionStart, createPersona, deletePersona } = await tenant();
    await createPersona("Unclonable", [
      { kind: "ApiKey", name: "ANTHROPIC", provider: "Anthropic", value: PROVIDER_KEY },
      { kind: "Variable", name: "GITHUB_TOKEN", value: github },
    ]);
    const start = await sessionStart("Unclonable");
    const failed: string[] = [];
    for (const cause of ["Refused", "TimedOut", "DirectoryNotEmpty", "Other"] as const) {
      const response = await postJson("/v1/sessions", { ...start, prompt: "clone fails" }, bearer);
      assert.equal(response.status, 200);
      const { sessionId } = StartedSessionSchema.parse(await response.json()).session;
      const offer = await host.next("TurnOffer");
      host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
      host.send({
        type: "TurnRepositoryCloneFailed",
        turnId: offer.turnId,
        cause,
        detail: "git reported: fatal: could not read Username",
        failedAt: new Date().toISOString(),
      });
      await until(
        "the turn reading Failed",
        () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
        (turn) => turn.state === "Failed",
      );
      const failure = await getJson(`/v1/turns/${offer.turnId}/failure`, TurnFailureSchema);
      assert.equal(failure.reason, "RepositoryCloneFailed");
      assert.match(
        failure.detail,
        /GITHUB_TOKEN of secret set Unclonable secrets can read it, then start a new session$/,
      );
      assert.equal((await getJson(`/v1/sessions/${sessionId}`, SessionSchema)).state, "Failed");
      assert.deepEqual(await host.next("BoxDiscard"), { type: "BoxDiscard", sessionId, boxId: offer.boxId });
      const send = await refused(`/v1/sessions/${sessionId}/turns`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "try again" }),
      });
      assert.equal(send.code, "SessionFailed");
      failed.push(sessionId);
    }
    assert.equal((await deletePersona(start.personaId ?? "")).status, 204);
    for (const sessionId of failed) {
      assert.equal((await tool("tumpel_session_archive", { sessionId }, SessionSchema)).state, "Archived");
    }
  });

  test("a claimed turn fails HostOffline when its host disconnects and does not come back", async () => {
    const { bearer, host, refused, getJson, sessionStart } = await tenant();
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "host goes away" }, bearer);
    assert.equal(response.status, 200);
    const started = StartedSessionSchema.parse(await response.json());
    const offer = await host.next("TurnOffer");
    assert.equal(offer.turnId, started.turn.turnId);
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: "{}" });
    await until(
      "the turn reading Running",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Running" && turn.lineCount === 1,
    );

    host.close();
    await until(
      "the turn reading Failed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    const failure = await getJson(`/v1/turns/${offer.turnId}/failure`, TurnFailureSchema);
    assert.equal(failure.reason, "HostOffline");
    assert.match(failure.detail, /^host box went offline during the turn/);
    assert.doesNotMatch(failure.detail, UUID);

    const offline = await refused(`/v1/sessions/${started.session.sessionId}/stop`);
    assert.equal(offline.code, "HostOffline");
    assert.match(offline.detail, /runs on host box, which is Offline/);
    assert.doesNotMatch(offline.detail, UUID);
  });

  test("a session moves off its offline host once a snapshot holds its last completed turn, and the old host's late frames leave its channel working", async () => {
    const { bearer, refused, getJson, enrol, sessionStart, hostState } = await tenant();
    const first = await enrol("move-from");
    let from = await connect(first.id, first.key, 16);
    await hostState(first.id, "Online");
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "move me" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const started = StartedSessionSchema.parse(await response.json());
    const { sessionId } = started.session;
    assert.equal(started.session.hostId, first.id);
    const offer = await from.next("TurnOffer");
    from.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
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
    assert.match(stranded.detail, /host move-from, which is Offline, and its snapshots miss 1 completed turn,/);

    from = await connect(first.id, first.key, 16, from.counters());
    await hostState(first.id, "Online");
    await store.put(request.storageKey, '{"entries":[]}');
    from.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
    await until(
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
    await until(
      "the unclaimed turn reading Failed",
      () => getJson(`/v1/turns/${lost.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );

    const second = await enrol("move-to");
    const to = await connect(second.id, second.key, 16);
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

    from = await connect(first.id, first.key, 16, from.counters());
    await hostState(first.id, "Online");
    const discard = await from.next("BoxDiscard");
    assert.deepEqual({ sessionId: discard.sessionId, boxId: discard.boxId }, { sessionId, boxId: offer.boxId });
    from.send({ type: "TurnClaim", turnId: lost.turnId, boxId: offer.boxId });
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
    from.send({ type: "TurnClaim", turnId: afterOffer.turnId, boxId: afterOffer.boxId });
    await until(
      "the turn on the old host reading Running",
      () => getJson(`/v1/turns/${afterOffer.turnId}`, TurnSchema),
      (turn) => turn.state === "Running",
    );
    assert.equal((await getJson(`/v1/turns/${lost.turnId}/failure`, TurnFailureSchema)).reason, "NotClaimed");
    from.close();
    to.close();
  });

  test("two sessions started at once on two equal hosts land on different hosts, since each counts the other's turn", async () => {
    const { bearer, getJson, enrol, sessionStart } = await tenant();
    const first = await enrol("equal-1");
    const second = await enrol("equal-2");
    const sides = [await connect(first.id, first.key, 32), await connect(second.id, second.key, 32)];
    await until(
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

  test("a turn a host refuses HostUpdating is offered to another host at once", async () => {
    const { bearer, getJson, enrol, sessionStart, hostState } = await tenant();
    const first = await enrol("updating-1");
    const second = await enrol("updating-2");
    const sides = new Map([
      [first.id, await connect(first.id, first.key, 32)],
      [second.id, await connect(second.id, second.key, 32)],
    ]);
    const side = (id: string): HostSide => {
      const found = sides.get(id);
      if (found === undefined) throw new Error(`no host side for ${id}`);
      return found;
    };
    await hostState(first.id, "Online");
    await hostState(second.id, "Online");
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "during a swap" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const started = StartedSessionSchema.parse(await response.json());
    const refusing = started.session.hostId;
    const taking = refusing === first.id ? second.id : first.id;
    assert.equal((await side(refusing).next("TurnOffer")).turnId, started.turn.turnId);
    side(refusing).send({
      type: "TurnFailed",
      turnId: started.turn.turnId,
      reason: "HostUpdating",
      detail: "this host is swapping to a new supervisor binary",
      failedAt: new Date().toISOString(),
    });
    const moved = await side(taking).next("TurnOffer");
    assert.equal(moved.turnId, started.turn.turnId);
    const session = await getJson(`/v1/sessions/${started.session.sessionId}`, SessionSchema);
    assert.deepEqual({ hostId: session.hostId, boxId: session.boxId }, { hostId: taking, boxId: moved.boxId });
    assert.equal((await getJson(`/v1/turns/${started.turn.turnId}`, TurnSchema)).state, "Offered");
    for (const side of sides.values()) side.close();
  });

  test("a turn the only host refuses HostUpdating stays Offered and is claimed after the host's next Hello", async () => {
    const { bearer, host, hostId, getJson, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const only = await enrol("updating-only");
    const swapping = await connect(only.id, only.key, 32);
    await hostState(only.id, "Online");
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "during a swap" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const { turn } = StartedSessionSchema.parse(await response.json());
    assert.equal((await swapping.next("TurnOffer")).turnId, turn.turnId);
    swapping.send({
      type: "TurnFailed",
      turnId: turn.turnId,
      reason: "HostUpdating",
      detail: "this host is swapping to a new supervisor binary",
      failedAt: new Date().toISOString(),
    });
    swapping.close();
    await hostState(only.id, "Offline");
    assert.equal((await getJson(`/v1/turns/${turn.turnId}`, TurnSchema)).state, "Offered");
    const swapped = await connect(only.id, only.key, 32, swapping.counters());
    const offer = await swapped.next("TurnOffer");
    assert.equal(offer.turnId, turn.turnId);
    swapped.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await swapped.next("TurnClaimed")).turnId, turn.turnId);
    assert.equal((await getJson(`/v1/turns/${turn.turnId}`, TurnSchema)).state, "Running");
    swapped.close();
  });

  test("a turn the only host refuses HostUpdating is offered again when its swap fails", async () => {
    const { bearer, host, hostId, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const only = await enrol("update-fails");
    const side = await connect(only.id, only.key, 32);
    await hostState(only.id, "Online");
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "swap fails" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const { turn } = StartedSessionSchema.parse(await response.json());
    assert.equal((await side.next("TurnOffer")).turnId, turn.turnId);
    side.send({
      type: "TurnFailed",
      turnId: turn.turnId,
      reason: "HostUpdating",
      detail: "this host is swapping to a new supervisor binary",
      failedAt: new Date().toISOString(),
    });
    side.send({
      type: "SupervisorUpdateFailed",
      fromSha256: "a".repeat(64),
      toSha256: "b".repeat(64),
      reason: "SupervisorUpdateSwapFailed",
      detail: "renaming the candidate over the binary failed",
      outputTail: [],
      failedAt: new Date().toISOString(),
    });
    const offer = await side.next("TurnOffer");
    assert.equal(offer.turnId, turn.turnId);
    side.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await side.next("TurnClaimed")).turnId, turn.turnId);
    side.close();
  });

  test("a turn sent while the only host restarts for an update waits in its channel and is claimed after its Hello", async () => {
    const { bearer, host, hostId, getJson, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const only = await enrol("restarting-only");
    const restarting = await connect(only.id, only.key, 32);
    await hostState(only.id, "Online");
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "first" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const { session } = StartedSessionSchema.parse(await response.json());
    const first = await restarting.next("TurnOffer");
    restarting.send({ type: "TurnClaim", turnId: first.turnId, boxId: first.boxId });
    restarting.send({ type: "TurnLine", turnId: first.turnId, lineSeq: 1, text: '{"type":"result"}' });
    restarting.send({
      type: "TurnComplete",
      turnId: first.turnId,
      lastLineSeq: 1,
      completedAt: new Date().toISOString(),
    });
    await until(
      "the first turn completing",
      () => getJson(`/v1/turns/${first.turnId}`, TurnSchema),
      (read) => read.state === "Completed",
    );
    restarting.send({
      type: "SupervisorUpdateStep",
      fromSha256: "a".repeat(64),
      toSha256: "b".repeat(64),
      releaseVersion: "0.2.0",
      boxesRunning: 0,
      phase: "Restarting",
      at: new Date().toISOString(),
    });
    await hostState(only.id, "Offline");
    restarting.close();
    const sent = await postJson(`/v1/sessions/${session.sessionId}/turns`, { prompt: "during the restart" }, bearer);
    assert.equal(sent.status, 200, await sent.clone().text());
    const turn = TurnSchema.parse(await sent.json());
    assert.equal(turn.state, "Offered");
    const restarted = await connect(only.id, only.key, 32, restarting.counters());
    const offer = await restarted.next("TurnOffer");
    assert.equal(offer.turnId, turn.turnId);
    restarted.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await restarted.next("TurnClaimed")).turnId, turn.turnId);
    restarted.close();
  });

  test("two hosts refusing their turns HostUpdating at the same moment each hand the turn to the other", async () => {
    const { bearer, getJson, enrol, sessionStart, hostState } = await tenant();
    const first = await enrol("crossing-1");
    const second = await enrol("crossing-2");
    const sides = new Map([
      [first.id, await connect(first.id, first.key, 32)],
      [second.id, await connect(second.id, second.key, 32)],
    ]);
    const side = (id: string): HostSide => {
      const found = sides.get(id);
      if (found === undefined) throw new Error(`no host side for ${id}`);
      return found;
    };
    await hostState(first.id, "Online");
    await hostState(second.id, "Online");
    const start = await sessionStart();
    const responses = await Promise.all(
      ["crossing one", "crossing two"].map((prompt) => postJson("/v1/sessions", { ...start, prompt }, bearer)),
    );
    const started = [];
    for (const response of responses) {
      assert.equal(response.status, 200, await response.clone().text());
      started.push(StartedSessionSchema.parse(await response.json()));
    }
    assert.deepEqual(started.map(({ session }) => session.hostId).toSorted(), [first.id, second.id].toSorted());
    for (const { session, turn } of started) {
      assert.equal((await side(session.hostId).next("TurnOffer")).turnId, turn.turnId);
    }
    for (const { session, turn } of started) {
      side(session.hostId).send({
        type: "TurnFailed",
        turnId: turn.turnId,
        reason: "HostUpdating",
        detail: "this host is swapping to a new supervisor binary",
        failedAt: new Date().toISOString(),
      });
    }
    for (const { session, turn } of started) {
      const taking = session.hostId === first.id ? second.id : first.id;
      const moved = await side(taking).next("TurnOffer");
      assert.equal(moved.turnId, turn.turnId);
      const placed = await getJson(`/v1/sessions/${session.sessionId}`, SessionSchema);
      assert.deepEqual({ hostId: placed.hostId, boxId: placed.boxId }, { hostId: taking, boxId: moved.boxId });
      assert.equal((await getJson(`/v1/turns/${turn.turnId}`, TurnSchema)).state, "Offered");
    }
    for (const side of sides.values()) side.close();
  });
});

test("a prebuild runs as a turn on a free host, its snapshot is its layer, and the repository's next session restores it", async () => {
  const { tenantId, bearer, host, getJson, sessionStart } = await tenant();
  await installPrebuiltApp(tenantId);
  const { personaId } = await sessionStart();
  const repository = "https://github.com/prebuilt/app";
  const response = await postJson("/v1/prebuilds", { repository, personaId, provider: "CircleCI" }, bearer);
  assert.equal(response.status, 200, await response.clone().text());
  const started = PrebuildSchema.parse(await response.json());
  assert.equal(started.status.state, "Dispatched");
  const offer = await host.next("TurnOffer");
  assert.equal(offer.prebuildCommitSha, PREBUILT_HEAD);
  assert.deepEqual(offer.credential.variables, [
    { name: "GITHUB_TOKEN", value: "installation-token" },
    { name: "GH_TOKEN", value: "installation-token" },
  ]);
  assert.deepEqual({ files: offer.personaFiles, snapshots: offer.snapshots }, { files: [], snapshots: [] });
  assert.deepEqual(installationTokenRequests.at(-1), { repositories: ["app"], permissions: { contents: "read" } });
  assert.equal(new URL(started.logUrl).pathname, `/v1/sessions/${offer.sessionId}/transcript`);
  const busy = await postJson("/v1/prebuilds", { repository, personaId, provider: "CircleCI", rebuild: true }, bearer);
  assert.equal(busy.status, 409, await busy.clone().text());
  assert.equal(ProblemSchema.parse(await busy.json()).code, "NoHostAvailable");

  host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
  await host.next("TurnClaimed");
  const read = () => getJson(`/v1/prebuilds/${started.prebuildId}`, PrebuildSchema);
  await until("the prebuild reading Building", read, (prebuild) => prebuild.status.state === "Building");
  host.send({ type: "TurnRepositoryReady", turnId: offer.turnId });
  host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: "prebuild: running onCreateCommand" });
  host.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  const request = await host.next("SnapshotRequest");
  assert.equal(request.sessionId, offer.sessionId);
  await store.put(request.storageKey, "prebuilt root");
  host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 4096 });
  const teardown = await host.next("BoxTeardown");
  host.send({ type: "BoxGone", sessionId: teardown.sessionId, boxId: teardown.boxId });
  const done = await until("the prebuild reading Done", read, (prebuild) => prebuild.status.state === "Done");
  if (done.status.state !== "Done") throw new Error(`prebuild ${started.prebuildId} is ${done.status.state}`);
  assert.deepEqual(
    { layerDigest: done.status.layerDigest, layerSizeBytes: done.status.layerSizeBytes },
    { layerDigest: createHash("sha256").update("prebuilt root").digest("hex"), layerSizeBytes: 4096 },
  );
  const listed = await getJson("/v1/sessions", SessionSchema.array());
  assert.ok(listed.every((session) => session.sessionId !== offer.sessionId));

  const next = await postJson(
    "/v1/sessions",
    { ...(await sessionStart()), repository, prompt: "use the prebuild" },
    bearer,
  );
  assert.equal(next.status, 200, await next.clone().text());
  const consumer = await host.next("TurnOffer");
  assert.equal(consumer.prebuildCommitSha, undefined);
  assert.deepEqual(
    consumer.snapshots.map((snapshot) => snapshot.snapshotId),
    [request.snapshotId],
  );
});
