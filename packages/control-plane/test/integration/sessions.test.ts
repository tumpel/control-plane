import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createHash,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, suite, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  BoxMemoryLimit,
  ChannelProtocol,
  ClaudeSetupSchema,
  CompactTranscriptPageSchema,
  CredentialHandoverSchema,
  EventCursorExpiredProblemSchema,
  EventPageSchema,
  FailedTurnSchema,
  HostSchema,
  type HostUsageSchema,
  MintedEnrolmentTokenSchema,
  OAuthClientSchema,
  OAuthTokenSchema,
  PersonaSchema,
  PrebuildPreviewSchema,
  PrebuildSchema,
  PrebuildTemplateSchema,
  PrebuildTemplateVersionSchema,
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
  SubscriptionSchema,
  SupervisorHostKeySchema,
  TenantEventSchema,
  TriggerSchema,
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
import { steerSettings } from "../../src/steer.ts";
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
const PROVIDER_KEY = "sk-ant-sessions-e2e-key";
const OFFER_TTL_SECONDS = 3;
const IMAGE_FETCH_BUDGET_SECONDS = 2;
const FIRST_LINE_BUDGET_SECONDS = 10;
const R2_STUB_ORIGIN = "https://r2.example.test";
type HostUsage = z.infer<typeof HostUsageSchema>;

const USAGE: HostUsage = {
  boxesWarm: 0,
  loadAverage: 0.25,
  memoryAvailableMib: 6144,
  diskBudgetMib: 200000,
  diskHeldMib: 32768,
};
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const SUPERVISOR = join(ROOT, ".tmp", "release-binaries", "tumpel-supervisor");
const SETTINGS = {
  ...TEST_SETTINGS,
  dispatchGrantTtlSeconds: OFFER_TTL_SECONDS + IMAGE_FETCH_BUDGET_SECONDS - 1,
  snapshotDelaySeconds: 1,
  snapshotDeadlineSeconds: 60,
  turnOfferTtlSeconds: OFFER_TTL_SECONDS,
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

const storeRoot = async (storageKey: string, digests: string[] = []): Promise<string> => {
  const chunks = digests.map((digest) => ({ digest, packDigest: digest, offset: 0, length: 1 }));
  const manifest = JSON.stringify({
    entries: [
      {
        kind: "File",
        path: "f",
        mode: 420,
        uid: 0,
        gid: 0,
        mtimeSeconds: 0,
        mtimeNanos: 0,
        sizeBytes: chunks.length,
        chunks,
      },
    ],
  });
  const digest = createHash("sha256").update(manifest).digest("hex");
  await store.put(`${storageKey.split("/")[0]}/packs/${digest}`, manifest);
  const root = JSON.stringify({ manifest: [{ digest, packDigest: digest, offset: 0, length: manifest.length }] });
  await store.put(storageKey, root);
  return root;
};
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

type Carried = { received: number; sent: number; held: string[] };

class HostSide {
  private received: number;
  private sent: number;
  private readonly held: Set<string>;
  private readonly resend: HostMessage[];
  private usage: HostUsage;
  private welcomed = false;
  private readonly inbox: ControlMessage[] = [];
  private readonly refusals: { seq: number; reason: string }[] = [];
  private closedWith: { code: number; wasClean: boolean } | null = null;
  private readonly waiters: (() => void)[] = [];
  private readonly heartbeat: NodeJS.Timeout;

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket, carried: Carried, resend: HostMessage[], usage: HostUsage) {
    this.socket = socket;
    this.usage = usage;
    this.received = carried.received;
    this.sent = carried.sent;
    this.held = new Set(carried.held);
    this.resend = resend;
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", (event) => {
      this.closedWith = { code: event.code, wasClean: event.wasClean };
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.heartbeat = setInterval(() => this.beat(), SETTINGS.heartbeatIntervalSeconds * 1000);
  }

  private beat(): void {
    if (!this.welcomed) return;
    this.raw({
      type: "Heartbeat",
      sentAt: new Date().toISOString(),
      usage: this.usage,
      heldSessionIds: [...this.held],
    });
  }

  quiet(): void {
    clearInterval(this.heartbeat);
  }

  report(usage: HostUsage): void {
    this.usage = usage;
    this.beat();
  }

  static async connect(
    id: string,
    key: KeyObject,
    boxCapacity = 8,
    carried: Carried = { received: 0, sent: 0, held: [] },
    resend: HostMessage[] = [],
    usage: HostUsage = USAGE,
  ): Promise<HostSide> {
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/v1/hosts/${id}/channel`);
    const challenge = await new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
      socket.addEventListener("error", () => reject(new Error("the host channel did not open")), { once: true });
    });
    const parsed = ControlEnvelopeSchema.parse(JSON.parse(challenge));
    assert.equal(parsed.type, "Challenge");
    const side = new HostSide(socket, carried, resend, usage);
    side.raw({
      type: "Hello",
      hostId: id,
      protocolVersion: ChannelProtocol.Version,
      supervisorVersion: "0.1.0",
      signature: sign(null, helloBytes(parsed.nonce, id), key).toString("base64"),
      boxCapacity,
      usage,
    });
    return side;
  }

  private raw(envelope: unknown): void {
    this.socket.send(JSON.stringify(envelope));
  }

  private receive(text: string): void {
    const envelope = ControlEnvelopeSchema.parse(JSON.parse(text));
    if (envelope.type === "Welcome") {
      this.welcomed = true;
      for (const message of this.resend) this.send(message);
    }
    if (envelope.type === "FrameRefused") {
      this.refusals.push({ seq: envelope.seq, reason: envelope.reason });
      for (const wake of this.waiters.splice(0)) wake();
      return;
    }
    if (envelope.type !== "Frame" || envelope.seq <= this.received) return;
    assert.equal(envelope.seq, this.received + 1, "the control plane skipped a frame");
    this.received = envelope.seq;
    if (envelope.message.type === "TurnOffer") this.held.add(envelope.message.sessionId);
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
      this.assertOpen(`waiting for ${type}`);
      const left = deadline - Date.now();
      if (left <= 0) assert.fail(`no ${type} reached the host`);
      await Promise.race([
        new Promise<void>((resolve) => this.waiters.push(resolve)),
        wait(left, undefined, { ref: false }),
      ]);
    }
  }

  async refusal(): Promise<{ seq: number; reason: string }> {
    const deadline = Date.now() + GIVE_UP_MS;
    for (;;) {
      const refused = this.refusals.shift();
      if (refused !== undefined) return refused;
      this.assertOpen("waiting for FrameRefused");
      const left = deadline - Date.now();
      if (left <= 0) assert.fail("no FrameRefused reached the host");
      await Promise.race([
        new Promise<void>((resolve) => this.waiters.push(resolve)),
        wait(left, undefined, { ref: false }),
      ]);
    }
  }

  assertOpen(when: string): void {
    if (this.closedWith === null) return;
    const { code, wasClean } = this.closedWith;
    assert.fail(
      `the control plane closed the channel ${wasClean ? "cleanly" : "without a close frame"} with ${code} ${when}`,
    );
  }

  holds(type: ControlMessage["type"]): boolean {
    return this.inbox.some((message) => message.type === type);
  }

  snapshotRequestsFor(sessionId: string): number {
    return this.inbox.filter((message) => message.type === "SnapshotRequest" && message.sessionId === sessionId).length;
  }

  carried(): Carried {
    return { received: this.received, sent: this.sent, held: [...this.held] };
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
const PREBUILT_DEVCONTAINER_TREE = "9".repeat(40);
const PREBUILT_DEVCONTAINER = "8".repeat(40);
const BARE_TREE = "a".repeat(40);
const installationTokenRequests: unknown[] = [];

const prebuiltRepository = (method: string, path: string): { status: number; body: unknown } | null => {
  if (method === "GET" && path === "/app/installations/77") {
    return { status: 200, body: { permissions: { contents: "write", metadata: "read" } } };
  }
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
    return {
      status: 200,
      body: {
        tree: [
          { path: ".devcontainer", type: "tree", sha: PREBUILT_DEVCONTAINER_TREE },
          { path: "package-lock.json", type: "blob", sha: "7".repeat(40) },
        ],
      },
    };
  }
  if (path === `/repos/prebuilt/app/git/trees/${PREBUILT_DEVCONTAINER_TREE}?recursive=1`) {
    return { status: 200, body: { tree: [{ path: "devcontainer.json", type: "blob", sha: PREBUILT_DEVCONTAINER }] } };
  }
  if (path === `/repos/prebuilt/app/git/blobs/${PREBUILT_DEVCONTAINER}`) {
    const content = Buffer.from('{ "onCreateCommand": "npm ci" }\n').toString("base64");
    return { status: 200, body: { content, encoding: "base64" } };
  }
  if (path === "/repos/prebuilt/bare") return { status: 200, body: { default_branch: "main" } };
  if (path === "/repos/prebuilt/bare/commits/main") {
    return { status: 200, body: { sha: PREBUILT_HEAD, commit: { tree: { sha: BARE_TREE } } } };
  }
  if (path === `/repos/prebuilt/bare/git/trees/${BARE_TREE}`) {
    return { status: 200, body: { tree: [{ path: "package-lock.json", type: "blob", sha: "7".repeat(40) }] } };
  }
  return null;
};

const storePrebuiltApp = async (): Promise<void> => {
  const keyStore = workersSecretKeyStore(Buffer.alloc(32, 7).toString("base64"));
  const dataKey = await generateDataKey();
  const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const privateKey = appKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  await d1Run(
    `INSERT OR IGNORE INTO github_apps (github_app_slot, app_id, slug, client_id, owner_login, html_url, wrapped_data_key,
    client_secret_sealed, webhook_secret_sealed, private_key_sealed, bot_user_id, created_at)
    VALUES (1, 1, 'tumpel-sessions', 'Iv1.sessions', 'prebuilt', 'https://github.com/apps/tumpel-sessions', ?, ?, ?, ?, 4343, ?)`,
    await keyStore.wrap(dataKey),
    await seal(dataKey, "sessions-client-secret", "github-app/client_secret"),
    await seal(dataKey, "sessions-webhook-secret", "github-app/webhook_secret"),
    await seal(dataKey, privateKey, "github-app/private_key"),
    Date.now(),
  );
};

const installPrebuiltApp = async (tenantId: string): Promise<void> => {
  await storePrebuiltApp();
  await d1Run(
    `INSERT INTO github_installations (installation_id, tenant_id, account_login, account_type, status, created_at, updated_at)
    VALUES (77, ?, 'prebuilt', 'Organization', 'Active', ?, ?)
    ON CONFLICT (installation_id) DO UPDATE SET tenant_id = excluded.tenant_id`,
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
    const enrolled = HostSchema.pick({ hostId: true }).parse(JSON.parse(stdout));
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
      model: "claude-sonnet-5-5",
      personaId: personas.find((persona) => persona.name === name)?.personaId,
    };
  };

  const createPersona = async (name: string, secrets: unknown[], files: unknown[] = []): Promise<void> => {
    const created = await postJson("/v1/secret-sets", { name: `${name} secrets`, secrets }, bearer);
    assert.equal(created.status, 200);
    const { secretSetId } = SecretSetSchema.parse(await created.json());
    const persona = { name, harness: "ClaudeCode", secretSetId, connectorIds: [], files };
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
    host.send({
      type: "TurnLine",
      turnId: offer.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    host.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    return { session: started.session, offer };
  };

  const storedSnapshot = async (sessionId: string): Promise<void> => {
    const request = await host.next("SnapshotRequest");
    assert.equal(request.sessionId, sessionId);
    await storeRoot(request.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
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
    await storeRoot(request.storageKey, digests);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 64 });
    await until(
      "a stored snapshot",
      () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
      (snapshots) => snapshots.some((snapshot) => snapshot.outcome.state === "Stored"),
    );
    await until(
      "the snapshotted turn reading Completed",
      () => tool("tumpel_turn_get", { turnId: request.turnId }, TurnSchema),
      (turn) => turn.state === "Completed",
    );
    return { request, held: answer.held, uploaded: uploads.uploads.map((upload) => upload.packDigest) };
  };

  return {
    tenantId,
    email,
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
    storedSnapshot,
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
            API_ORIGIN: "https://api.tumpel.test",
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

test("a start naming a model the harness does not run is refused ModelUnsupported and places no session", async () => {
  const { bearer, getJson, sessionStart } = await tenant();
  const refusal = await postJson(
    "/v1/sessions",
    { ...(await sessionStart()), model: "gpt-5-codex", prompt: "wrong model" },
    bearer,
  );
  assert.equal(refusal.status, 422);
  const problem = ProblemSchema.parse(await refusal.json());
  assert.equal(problem.code, "ModelUnsupported");
  assert.match(
    problem.detail,
    /^ClaudeCode does not run model gpt-5-codex with ApiKey ANTHROPIC of .*; it runs opus, .*claude-sonnet-5-5/,
  );
  assert.deepEqual(await getJson("/v1/sessions", SessionSchema.array()), []);
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
      channelProtocols: [],
    });

    const start = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "during the drain" }, bearer);
    assert.equal(start.status, 503);
    const startRefusal = ProblemSchema.parse(await start.json());
    assert.equal(startRefusal.code, "DeployInProgress");
    assert.match(startRefusal.detail, /a deploy of the control plane is in progress/);
    assert.equal(startRefusal.fix, "Once the dashboard shows the new release, start again");

    host.send({
      type: "TurnFailed",
      turnId: offer.turnId,
      reason: "BoxBootFailed",
      detail: "the box did not boot",
      failedAt: new Date().toISOString(),
    });
    await until(
      "the offered turn reading Failed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    assert.deepEqual(await report(), {
      deployedCommit: DEPLOYED_COMMIT,
      drained: true,
      hosts: [],
      channelProtocols: [],
    });

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
      {
        hostId: usage?.hostId,
        boxCapacity: usage?.boxCapacity,
        boxesRunning: usage?.boxesRunning,
        diskBudgetMib: usage?.diskBudgetMib,
        diskHeldMib: usage?.diskHeldMib,
      },
      { hostId, boxCapacity: 8, boxesRunning: 1, diskBudgetMib: 200000, diskHeldMib: 32768 },
    );

    const offer = await host.next("TurnOffer");
    assert.equal(offer.turnId, started.turn.turnId);
    assert.deepEqual(
      { boxMemoryMib: offer.boxMemoryMib, boxDiskMib: offer.boxDiskMib },
      { boxMemoryMib: 2048, boxDiskMib: 32768 },
    );
    assert.equal(offer.sessionId, started.session.sessionId);
    assert.equal(offer.prompt, "fix the build");
    assert.deepEqual(offer.credential.variables, [
      { name: "ANTHROPIC_API_KEY", value: PROVIDER_KEY },
      { name: "GITHUB_TOKEN", value: github },
    ]);
    assert.ok(Date.parse(offer.credential.expiresAt) > Date.now());
    assert.equal(offer.lastLineSeq, 0);
    assert.deepEqual(offer.snapshots, []);
    const settings = steerSettings(SETTINGS_FILE) ?? "";
    const digest = createHash("sha256").update(settings).digest("hex");
    assert.deepEqual(
      offer.personaFiles.map((file) => [file.path, file.digest, file.sizeBytes]),
      [[".claude/settings.json", digest, Buffer.byteLength(settings)]],
    );
    assert.deepEqual(
      offer.credential.connectors.map((connector) => [connector.connectorId, new URL(connector.url).pathname]),
      [["steer", `/v1/turns/${offer.turnId}/steer-inbox`]],
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
    const booted = await getJson(`/v1/sessions/${started.session.sessionId}`, SessionSchema);
    assert.deepEqual(booted.lastTurnImage, {
      kind: "Layered",
      baseImageDigest: image.base.imageDigest,
      harnessLayerDigest: image.layer.layer.layerDigest,
    });
    assert.equal(booted.prebuildLayer?.layer === "None" && booted.prebuildLayer.reason, "NoPrebuild");
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

    const result = JSON.stringify({ type: "result", subtype: "success", is_error: false });
    host.send({ type: "TurnLine", turnId, lineSeq: 4, text: result });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 4, completedAt: new Date().toISOString() });
    const request = await host.next("SnapshotRequest");
    assert.equal(request.sessionId, sessionId);
    assert.equal(request.turnId, turnId);
    assert.equal(request.snapshotSeq, 1);
    const upload = new URL(request.uploadUrl);
    assert.equal(upload.origin, R2_STUB_ORIGIN);
    assert.equal(upload.pathname, `/tumpel-sessions/${request.storageKey}`);
    assert.equal(upload.searchParams.get("X-Tumpel-Method"), "PUT");
    assert.ok(Date.parse(request.uploadExpiresAt) > Date.now());
    await storeRoot(request.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 4096 });
    const completed = await until(
      "the turn reading Completed",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Completed",
    );
    assert.equal(completed.lineCount, 4);
    const all = [...expected, { lineSeq: 4, text: result }];
    assert.deepEqual(await readAll(sessionId, turnId, 10), all);
    assert.deepEqual(await readAll(sessionId, turnId, 1), all);
    const first = await tool("tumpel_transcript_read", { sessionId, limit: 1 }, RawTranscriptPageSchema);
    assert.equal(first.cursor, 1);
    assert.equal(first.finished, false);
    const last = await tool("tumpel_transcript_read", { sessionId, after: 2 }, RawTranscriptPageSchema);
    assert.equal(last.cursor, 4);
    assert.equal(last.finished, true);
    const pastDropped = await tool(
      "tumpel_transcript_read",
      { sessionId, compact: true, limit: 1 },
      CompactTranscriptPageSchema,
    );
    assert.deepEqual(pastDropped.turns, [{ turnId, lines: [{ lineSeq: 2, text: "on it" }] }]);
    assert.equal(pastDropped.cursor, 2);

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
    assert.equal(next.lastLineSeq, 4);
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
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: false });
    [...texts, result].forEach((text, index) => {
      host.send({ type: "TurnLine", turnId, lineSeq: index + 1, text });
    });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 8, completedAt: new Date().toISOString() });
    const request = await host.next("SnapshotRequest");
    assert.equal(request.sessionId, sessionId);
    await storeRoot(request.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 4096 });
    const completed = await until(
      "the turn reading Completed",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Completed",
    );
    assert.equal(completed.lineCount, 8);
    const raw = await tool("tumpel_transcript_read", { sessionId, turnId, limit: 100 }, RawTranscriptPageSchema);
    assert.deepEqual(
      raw.lines.map(({ lineSeq, text }) => ({ lineSeq, text })),
      [...texts, result].map((text, index) => ({ lineSeq: index + 1, text })),
    );
    assert.equal(raw.cursor, 8);
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
    await storeRoot(request.storageKey);
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

    const persona = await postJson(
      "/v1/personas",
      { name: "Codex", harness: "Codex", secretSetId, connectorIds: [], files: [] },
      bearer,
    );
    assert.equal(persona.status, 200, await persona.clone().text());
    const { personaId } = PersonaSchema.parse(await persona.json());
    await tool(
      "tumpel_session_start",
      { repository: "https://github.com/acme/app.git", model: "gpt-5.6-sol", personaId, prompt: "refresh" },
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

  test("a stop frees an idle session's box once a snapshot holds its last turn, and an archive deletes its snapshots, keeps its transcript and refuses later sends, and frees its persona for delete", async () => {
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
    const running = await refused(`/v1/sessions/${sessionId}/archive`);
    assert.equal(running.code, "SessionNotStopped");
    assert.match(running.detail, /is Running/);

    host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result","subtype":"success","is_error":false}' });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    const request = await host.next("SnapshotRequest");
    assert.equal(request.sessionId, sessionId);
    assert.equal(request.turnId, turnId);
    await storeRoot(request.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
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
      assert.deepEqual(session?.origin, { kind: "Prompt" });
    }
    const stopping = await tool("tumpel_session_stop", { sessionId }, SessionSchema);
    assert.equal(stopping.state, "Stopping");
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
      new RegExp(
        `persona ${start.personaId} is still used by session ${sessionId}, which is neither Failed nor Archived$`,
      ),
    );

    const archived = await tool("tumpel_session_archive", { sessionId }, SessionSchema);
    assert.equal(archived.state, "Archived");
    assert.equal((await deletePersona(start.personaId ?? "")).status, 204);
    assert.equal((await tool("tumpel_session_get", { sessionId }, SessionSchema)).personaId, start.personaId);
    assert.equal((await tool("tumpel_session_archive", { sessionId }, SessionSchema)).state, "Archived");
    assert.equal(await store.text(request.storageKey), null);
    assert.deepEqual(await tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()), []);
    assert.deepEqual(await readAll(sessionId, turnId, 10), [
      { lineSeq: 1, text: '{"type":"result","subtype":"success","is_error":false}' },
    ]);
    const archivedSend = await refused(`/v1/sessions/${sessionId}/turns`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "one more" }),
    });
    assert.equal(archivedSend.code, "SessionArchived");
    assert.match(archivedSend.detail, new RegExp(`session ${sessionId} is archived`));
  });

  test("an archive discards an idle session's box without a snapshot and deletes its snapshots, and the list keeps sessions with no turn since a time", async () => {
    const { host, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "archive me" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result"}' });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    const warm = await host.next("SnapshotRequest");
    await storeRoot(warm.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: warm.snapshotId, uploadedBytes: 14 });
    await until(
      "a stored snapshot",
      () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
      (snapshots) => snapshots.length === 1,
    );

    const idle = await tool("tumpel_session_get", { sessionId }, SessionSchema);
    assert.equal(idle.state, "Idle");
    const lastTurnAt = Date.parse(idle.lastTurnAt);
    const listed = async (lastTurnBefore: number) =>
      (
        await tool(
          "tumpel_session_list",
          { lastTurnBefore: new Date(lastTurnBefore).toISOString() },
          SessionSchema.array(),
        )
      ).map((session) => session.sessionId);
    assert.deepEqual(await listed(lastTurnAt), [sessionId]);
    assert.deepEqual(await listed(lastTurnAt - 1), []);

    const archived = await tool("tumpel_session_archive", { sessionId }, SessionSchema);
    assert.equal(archived.state, "Archived");
    assert.deepEqual(await host.next("BoxDiscard"), { type: "BoxDiscard", sessionId, boxId: offer.boxId });
    assert.equal(await store.text(warm.storageKey), null);
    assert.deepEqual(await tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()), []);
  });

  test("a session starts with tags, the list keeps only sessions carrying every tag, and set and patch replace and merge them", async () => {
    const { tool, toolRefusal, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "tag me", tags: ["crew:a", "b"] },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    assert.deepEqual(started.session.tags, ["b", "crew:a"]);
    assert.deepEqual(started.session.startedBy, { kind: "Person", principalId: started.session.principalId });
    const listed = async (tag: string[]) =>
      (await tool("tumpel_session_list", { tag }, SessionSchema.array())).map((session) => session.sessionId);
    assert.deepEqual(await listed(["crew:a", "b"]), [sessionId]);
    assert.deepEqual(await listed(["crew:a", "x"]), []);

    const patched = await tool(
      "tumpel_session_patch_tags",
      { sessionId, add: ["x", "crew:a"], remove: ["b"] },
      SessionSchema,
    );
    assert.deepEqual(patched.tags, ["crew:a", "x"]);
    assert.deepEqual(await listed(["crew:a", "x"]), [sessionId]);
    const many = Array.from({ length: 15 }, (_, index) => `t${index}`);
    assert.match(await toolRefusal("tumpel_session_patch_tags", { sessionId, add: many }), /at most 16/);
    assert.deepEqual((await tool("tumpel_session_set_tags", { sessionId, tags: [] }, SessionSchema)).tags, []);
    assert.deepEqual((await tool("tumpel_session_get", { sessionId }, SessionSchema)).tags, []);
  });

  test("a goal reaches Claude Code as one /goal prompt with a turn cap and reads back on the turn", async () => {
    const { tenantId, bearer, host, getJson, tool, completedTurn } = await tenant();
    const { session, offer } = await completedTurn("set up the repository");
    const { sessionId } = session;
    assert.equal(offer.prompt, "set up the repository");
    const request = await host.next("SnapshotRequest");
    await storeRoot(request.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
    await until(
      "the first turn reading Completed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Completed",
    );

    const tooLong = await postJson(
      `/v1/sessions/${sessionId}/turns`,
      { prompt: "p".repeat(3990), goal: "the tests pass" },
      bearer,
    );
    assert.equal(tooLong.status, 400);
    const refusal = ProblemSchema.parse(await tooLong.json());
    assert.equal(
      refusal.detail,
      "the prompt and goal make a goal message of 4048 characters, and ClaudeCode takes at most 4000",
    );
    assert.equal(refusal.fix, "Shorten the prompt or the goal by 48 characters, then send again");

    const sent = await tool(
      "tumpel_turn_send",
      { sessionId, prompt: "fix the flaky test", goal: "npm test passes three times in a row" },
      TurnSchema,
    );
    assert.equal(sent.goal, "npm test passes three times in a row");
    const goalOffer = await host.next("TurnOffer");
    assert.equal(
      goalOffer.prompt,
      "/goal fix the flaky test\n\nDone when: npm test passes three times in a row. Or stop after 20 turns.",
    );
    assert.deepEqual(
      (await getJson(`/v1/sessions/${sessionId}/turns`, TurnSchema.array())).map((turn) => [turn.prompt, turn.goal]),
      [
        ["set up the repository", undefined],
        ["fix the flaky test", "npm test passes three times in a row"],
      ],
    );
    assert.equal((await getJson(`/v1/turns/${sent.turnId}`, TurnSchema)).goal, "npm test passes three times in a row");

    await tenantSql(tenantId, "UPDATE sessions SET harness = 'Codex' WHERE session_id = ?", sessionId);
    const codex = await postJson(`/v1/sessions/${sessionId}/turns`, { prompt: "go on", goal: "done" }, bearer);
    assert.equal(codex.status, 400);
    assert.match(
      ProblemSchema.parse(await codex.json()).detail,
      /runs Codex, which takes no goal; ClaudeCode takes one$/,
    );
  });

  test("a stopped Codex foreman dispatches crew, ends its event turn while the subscription goal is unmet, and gets the next crew turn on a fresh box from its snapshot", async () => {
    const { bearer, host, github, tool, storedSnapshot, sessionStart } = await tenant();
    const secrets = await postJson(
      "/v1/secret-sets",
      {
        name: "Foreman secrets",
        secrets: [
          { kind: "ApiKey", name: "OPENAI", provider: "OpenAi", value: "sk-proj-foreman-test" },
          { kind: "Variable", name: "GITHUB_TOKEN", value: github },
        ],
      },
      bearer,
    );
    assert.equal(secrets.status, 200, await secrets.clone().text());
    const { secretSetId } = SecretSetSchema.parse(await secrets.json());
    const created = await postJson(
      "/v1/personas",
      { name: "Foreman", harness: "Codex", secretSetId, connectorIds: [], tumpelMcp: true },
      bearer,
    );
    assert.equal(created.status, 200, await created.clone().text());
    const start = { ...(await sessionStart("Foreman")), model: "gpt-5.6-sol" };
    const asTurn = async (token: string, name: string, args: Record<string, unknown>) => {
      mcpId += 1;
      const response = await postJson(
        "/mcp",
        { jsonrpc: "2.0", id: mcpId, method: "tools/call", params: { name, arguments: args } },
        { authorization: `Bearer ${token}` },
      );
      return { status: response.status, text: await response.text() };
    };
    const turnToken = async (offer: Extract<ControlMessage, { type: "TurnOffer" }>): Promise<string> => {
      const connector = offer.credential.connectors.find((each) => each.connectorId === "tumpel");
      assert.ok(connector, `turn ${offer.turnId} carries no tumpel connector`);
      const served = await call(new URL(connector.tokenUrl).pathname, {
        method: "POST",
        headers: { authorization: `Bearer ${connector.tokenCredential}` },
      });
      assert.equal(served.status, 200, await served.clone().text());
      return z.object({ accessToken: z.string() }).parse(await served.json()).accessToken;
    };
    const finish = async (offer: Extract<ControlMessage, { type: "TurnOffer" }>): Promise<void> => {
      const result = '{"type":"turn.completed"}';
      host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: offer.lastLineSeq + 1, text: result });
      host.send({
        type: "TurnComplete",
        turnId: offer.turnId,
        lastLineSeq: offer.lastLineSeq + 1,
        completedAt: new Date().toISOString(),
      });
      await storedSnapshot(offer.sessionId);
      await until(
        `turn ${offer.turnId} reading Completed`,
        () => tool("tumpel_turn_get", { turnId: offer.turnId }, TurnSchema),
        (turn) => turn.state === "Completed",
      );
    };

    const foreman = await tool(
      "tumpel_session_start",
      { ...start, prompt: "work through the open issues" },
      StartedSessionSchema,
    );
    const foremanId = foreman.session.sessionId;
    const subscription = await tool(
      "tumpel_subscription_create",
      {
        sessionId: foremanId,
        prompt: "start a crew session per open issue and review what it did",
        goal: "every open issue has a merged pull request",
        events: ["TurnCompleted"],
        crewTags: ["crew:issues"],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      SubscriptionSchema,
    );
    assert.equal(subscription.state, "Active");

    const foremanTurn = await host.next("TurnOffer");
    assert.equal(foremanTurn.sessionId, foremanId);
    host.send({ type: "TurnClaim", turnId: foremanTurn.turnId, boxId: foremanTurn.boxId });
    await until(
      "the foreman turn reading Running",
      () => tool("tumpel_turn_get", { turnId: foremanTurn.turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );
    const foremanToken = await turnToken(foremanTurn);
    const overLimit = await asTurn(foremanToken, "tumpel_session_start", {
      ...start,
      prompt: "too many tags",
      tags: Array.from({ length: 16 }, (_, index) => `own-${index}`),
    });
    assert.match(overLimit.text, /would carry 17 tags, its own and the crew tags it inherits/);
    const crewStart = await asTurn(foremanToken, "tumpel_session_start", {
      ...start,
      prompt: "fix issue 12",
      tags: ["issue-12"],
    });
    const crew = StartedSessionSchema.parse(
      JSON.parse(
        z
          .object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) })
          .parse(JSON.parse(crewStart.text)).result.content[0]?.text ?? "",
      ),
    );
    assert.deepEqual(crew.session.tags, ["crew:issues", "issue-12"]);
    assert.deepEqual(crew.session.startedBy, { kind: "Turn", sessionId: foremanId, turnId: foremanTurn.turnId });
    await finish(foremanTurn);
    const afterTurn = await asTurn(foremanToken, "tumpel_whoami", {});
    assert.equal(afterTurn.status, 401, `a token of a completed turn still answered ${afterTurn.text}`);
    assert.equal((await tool("tumpel_session_stop", { sessionId: foremanId }, SessionSchema)).state, "Stopping");
    const teardown = await host.next("BoxTeardown");
    assert.deepEqual(teardown, { type: "BoxTeardown", sessionId: foremanId, boxId: foremanTurn.boxId });
    host.send({ type: "BoxGone", sessionId: foremanId, boxId: teardown.boxId });
    await until(
      "the foreman reading Stopped",
      () => tool("tumpel_session_get", { sessionId: foremanId }, SessionSchema),
      (session) => session.state === "Stopped",
    );

    const crewTurn = await host.next("TurnOffer");
    assert.equal(crewTurn.sessionId, crew.session.sessionId);
    host.send({ type: "TurnClaim", turnId: crewTurn.turnId, boxId: crewTurn.boxId });
    await until(
      "the crew turn reading Running",
      () => tool("tumpel_turn_get", { turnId: crewTurn.turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );
    const crewToken = await turnToken(crewTurn);
    const refused = await asTurn(crewToken, "tumpel_subscription_resume", {
      subscriptionId: subscription.subscriptionId,
    });
    assert.match(refused.text, /only a person creates or resumes a subscription/);
    await finish(crewTurn);

    const delivery = await host.next("TurnOffer");
    assert.equal(delivery.sessionId, foremanId);
    assert.equal(delivery.harness, "Codex");
    assert.notEqual(delivery.boxId, foremanTurn.boxId);
    assert.ok(delivery.snapshots.length > 0, "the delivery restores the foreman snapshot");
    assert.ok(delivery.credential.connectors.some((connector) => connector.connectorId === "tumpel"));
    assert.match(delivery.prompt, /^start a crew session per open issue and review what it did\n\n/);
    assert.match(delivery.prompt, /every open issue has a merged pull request/);
    assert.match(delivery.prompt, /Call tumpel_subscription_complete when the goal holds\./);
    const deliveryTurn = await tool("tumpel_turn_get", { turnId: delivery.turnId }, TurnSchema);
    assert.equal(deliveryTurn.goal, undefined);
    assert.equal(deliveryTurn.prompt, delivery.prompt);
    const events = delivery.prompt
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => TenantEventSchema.parse(JSON.parse(line)));
    assert.deepEqual(
      events.map((event) => [event.event, "sessionId" in event ? event.sessionId : null]),
      [["TurnCompleted", crew.session.sessionId]],
    );
    host.send({ type: "TurnClaim", turnId: delivery.turnId, boxId: delivery.boxId });
    await finish(delivery);
    const delivered = await tool(
      "tumpel_subscription_get",
      { subscriptionId: subscription.subscriptionId },
      SubscriptionSchema,
    );
    assert.equal(delivered.cursorEventId, events[0]?.eventId);
    assert.equal(delivered.state, "Active");

    const completed = await tool(
      "tumpel_subscription_complete",
      { subscriptionId: subscription.subscriptionId },
      SubscriptionSchema,
    );
    assert.equal(completed.state === "Ended" ? completed.reason : completed.state, "GoalMet");
  });

  test("a stop with cancelTurn fails the running turn Cancelled, snapshots and frees its box, and the next send boots a fresh box", async () => {
    const { email, host, refused, getJson, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "run away" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"assistant"}' });
    await until(
      "the turn reading Running",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );
    assert.equal((await refused(`/v1/sessions/${sessionId}/stop`)).code, "TurnInFlight");

    const stopping = await tool("tumpel_session_stop", { sessionId, cancelTurn: true }, SessionSchema);
    assert.equal(stopping.state, "Stopping");
    assert.deepEqual(await host.next("TurnCancel"), { type: "TurnCancel", turnId });
    host.send({ type: "TurnLine", turnId, lineSeq: 2, text: '{"type":"assistant"}' });
    host.send({
      type: "TurnFailed",
      turnId,
      reason: "Cancelled",
      detail: "the host cancelled the turn",
      failedAt: new Date().toISOString(),
    });
    const failure = await tool("tumpel_turn_failure", { turnId }, TurnFailureSchema);
    assert.equal(failure.reason, "Cancelled");
    assert.match(
      failure.detail,
      new RegExp(`^${email} stopped the session and cancelled the turn while it was Running$`),
    );

    const request = await host.next("SnapshotRequest");
    assert.equal(request.turnId, turnId);
    await storeRoot(request.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
    const teardown = await host.next("BoxTeardown");
    assert.deepEqual(teardown, { type: "BoxTeardown", sessionId, boxId: offer.boxId });
    host.send({ type: "BoxGone", sessionId, boxId: teardown.boxId });
    await until(
      "the session reading Stopped",
      () => getJson(`/v1/sessions/${sessionId}`, SessionSchema),
      (session) => session.state === "Stopped",
    );
    assert.equal((await tool("tumpel_turn_get", { turnId }, TurnSchema)).lineCount, 1);

    await tool("tumpel_turn_send", { sessionId, prompt: "try again" }, TurnSchema);
    const next = await host.next("TurnOffer");
    assert.notEqual(next.boxId, offer.boxId);
    assert.deepEqual(
      next.snapshots.map((snapshot) => snapshot.snapshotId),
      [request.snapshotId],
    );
  });

  test("a cancel before the claim withdraws the claim, fails the turn Cancelled and stops the session", async () => {
    const { host, getJson, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "never mind" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;

    const stopping = await tool("tumpel_session_stop", { sessionId, cancelTurn: true }, SessionSchema);
    assert.equal(stopping.state, "Stopping");
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    assert.deepEqual(await host.next("TurnWithdrawn"), { type: "TurnWithdrawn", turnId });
    assert.equal((await tool("tumpel_turn_failure", { turnId }, TurnFailureSchema)).reason, "Cancelled");

    const request = await host.next("SnapshotRequest");
    await storeRoot(request.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
    const teardown = await host.next("BoxTeardown");
    host.send({ type: "BoxGone", sessionId, boxId: teardown.boxId });
    await until(
      "the session reading Stopped",
      () => getJson(`/v1/sessions/${sessionId}`, SessionSchema),
      (session) => session.state === "Stopped",
    );
  });

  test("a TurnComplete that crosses the cancel leaves the turn failed Cancelled", async () => {
    const { host, getJson, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "almost done" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result","subtype":"success","is_error":false}' });
    await until(
      "the turn reading Running",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );

    await tool("tumpel_session_stop", { sessionId, cancelTurn: true }, SessionSchema);
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    assert.deepEqual(await host.next("TurnCancel"), { type: "TurnCancel", turnId });
    const request = await host.next("SnapshotRequest");
    await storeRoot(request.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
    const teardown = await host.next("BoxTeardown");
    host.send({ type: "BoxGone", sessionId, boxId: teardown.boxId });
    await until(
      "the session reading Stopped",
      () => getJson(`/v1/sessions/${sessionId}`, SessionSchema),
      (session) => session.state === "Stopped",
    );

    assert.equal((await tool("tumpel_turn_get", { turnId }, TurnSchema)).state, "Failed");
    assert.equal((await tool("tumpel_turn_failure", { turnId }, TurnFailureSchema)).reason, "Cancelled");
  });

  test("turns sent while a turn runs wait Offered and start in send order, each when the turn before it ends", async () => {
    const { host, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "one" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const first = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: first.turnId, boxId: first.boxId });
    await until(
      "the turn reading Running",
      () => tool("tumpel_turn_get", { turnId: first.turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );

    const second = await tool("tumpel_turn_send", { sessionId, prompt: "two" }, TurnSchema);
    const third = await tool("tumpel_turn_send", { sessionId, prompt: "three" }, TurnSchema);
    assert.deepEqual([second.state, third.state], ["Offered", "Offered"]);
    assert.equal(host.holds("TurnOffer"), false);

    host.send({
      type: "TurnFailed",
      turnId: first.turnId,
      reason: "HarnessExited",
      detail: "the harness exited",
      failedAt: new Date().toISOString(),
    });
    const secondOffer = await host.next("TurnOffer");
    assert.deepEqual([secondOffer.turnId, secondOffer.boxId], [second.turnId, first.boxId]);
    assert.equal(host.holds("TurnOffer"), false);
    host.send({ type: "TurnClaim", turnId: second.turnId, boxId: secondOffer.boxId });
    host.send({
      type: "TurnLine",
      turnId: second.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    host.send({ type: "TurnComplete", turnId: second.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    const snapshot = await host.next("SnapshotRequest");
    assert.equal(snapshot.turnId, second.turnId);
    assert.equal(host.holds("TurnOffer"), false, "the third turn waits for the second turn's snapshot");
    await storeRoot(snapshot.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: snapshot.snapshotId, uploadedBytes: 14 });

    assert.equal((await host.next("TurnOffer")).turnId, third.turnId);
    assert.equal((await tool("tumpel_turn_get", { turnId: second.turnId }, TurnSchema)).state, "Completed");
  });

  test("a waiting turn's whole-turn budget starts when it starts, not when it was sent", async () => {
    const { host, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "long" },
      StartedSessionSchema,
    );
    const { sessionId, tenantId } = started.session;
    const first = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: first.turnId, boxId: first.boxId });
    await until(
      "the turn reading Running",
      () => tool("tumpel_turn_get", { turnId: first.turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );
    const waiting = await tool("tumpel_turn_send", { sessionId, prompt: "behind it" }, TurnSchema);
    await tenantSql(
      tenantId,
      "UPDATE turns SET created_at = ? WHERE turn_id = ?",
      Date.now() - (SETTINGS.turnTotalBudgetSeconds + 10) * 1000,
      waiting.turnId,
    );

    const ended = Date.now();
    host.send({
      type: "TurnFailed",
      turnId: first.turnId,
      reason: "HarnessExited",
      detail: "the harness exited",
      failedAt: new Date().toISOString(),
    });
    assert.equal((await host.next("TurnOffer")).turnId, waiting.turnId);
    const total = z
      .object({ turnId: z.string(), at: z.number() })
      .parse((await storedTimers(sessionId))?.deadlines.Total);
    assert.equal(total.turnId, waiting.turnId);
    assert.ok(total.at >= ended + SETTINGS.turnTotalBudgetSeconds * 1000, `${total.at} is before ${ended}`);
    assert.equal((await tool("tumpel_turn_get", { turnId: waiting.turnId }, TurnSchema)).state, "Offered");
  });

  test("a cancel fails a waiting turn Cancelled and the turns behind it keep their order, and a running turn is refused", async () => {
    const { email, host, refused, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "busy" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const first = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: first.turnId, boxId: first.boxId });
    await until(
      "the turn reading Running",
      () => tool("tumpel_turn_get", { turnId: first.turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );
    const second = await tool("tumpel_turn_send", { sessionId, prompt: "never mind" }, TurnSchema);
    const third = await tool("tumpel_turn_send", { sessionId, prompt: "after it" }, TurnSchema);

    const cancelled = await tool("tumpel_turn_cancel", { turnId: second.turnId }, TurnSchema);
    assert.equal(cancelled.state, "Failed");
    const failure = await tool("tumpel_turn_failure", { turnId: second.turnId }, TurnFailureSchema);
    assert.deepEqual([failure.reason, failure.detail], ["Cancelled", `${email} cancelled the turn while it waited`]);
    const running = await refused(`/v1/turns/${first.turnId}/cancel`);
    assert.equal(running.code, "TurnNotWaiting");

    host.send({
      type: "TurnFailed",
      turnId: first.turnId,
      reason: "HarnessExited",
      detail: "the harness exited",
      failedAt: new Date().toISOString(),
    });
    assert.equal((await host.next("TurnOffer")).turnId, third.turnId);
    assert.equal(host.holds("TurnOffer"), false);
  });

  test("a stop with cancelTurn fails every waiting turn Cancelled before it starts, and a stop without it is refused while one waits", async () => {
    const { email, host, refused, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "busy" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const first = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: first.turnId, boxId: first.boxId });
    await until(
      "the turn reading Running",
      () => tool("tumpel_turn_get", { turnId: first.turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );
    const waiting = await tool("tumpel_turn_send", { sessionId, prompt: "never mind" }, TurnSchema);
    assert.equal((await refused(`/v1/sessions/${sessionId}/stop`)).code, "TurnInFlight");

    const stopping = await tool("tumpel_session_stop", { sessionId, cancelTurn: true }, SessionSchema);
    assert.equal(stopping.state, "Stopping");
    assert.deepEqual(await host.next("TurnCancel"), { type: "TurnCancel", turnId: first.turnId });
    const failure = await tool("tumpel_turn_failure", { turnId: waiting.turnId }, TurnFailureSchema);
    assert.equal(failure.reason, "Cancelled");
    assert.equal(
      failure.detail,
      `${email} stopped the session and cancelled the turn while it waited for turn ${first.turnId}`,
    );
    assert.equal((await tool("tumpel_turn_failure", { turnId: first.turnId }, TurnFailureSchema)).reason, "Cancelled");
    await host.next("SnapshotRequest");
    assert.equal(host.holds("TurnOffer"), false);
  });

  test("a stop whose teardown the host refuses returns to Idle and becomes evictable after its recovery snapshot", async () => {
    const { bearer, host, hostId, getJson, tool, sessionStart, enrol, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const enrolled = await enrol("tight");
    const side = await connect(enrolled.id, enrolled.key, 1);
    await hostState(enrolled.id, "Online");
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "keep my box" },
      StartedSessionSchema,
    );
    const { sessionId } = started.session;
    const offer = await side.next("TurnOffer");
    const { turnId } = offer;
    side.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    side.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result","subtype":"success","is_error":false}' });
    side.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    const warm = await side.next("SnapshotRequest");
    await storeRoot(warm.storageKey);
    side.send({ type: "SnapshotDone", snapshotId: warm.snapshotId, uploadedBytes: 14 });
    await until(
      "a stored snapshot",
      () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
      (snapshots) => snapshots.length === 1,
    );

    await tool("tumpel_session_stop", { sessionId }, SessionSchema);
    const teardown = await side.next("BoxTeardown");
    const failedAt = new Date().toISOString();
    const detail = `box ${teardown.boxId} holds turn ${turnId}, which no snapshot holds; snapshot it, then tear it down`;
    side.send({ type: "BoxTeardownFailed", sessionId, boxId: teardown.boxId, reason: "BoxDirty", detail, failedAt });
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
    const blocked = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "wait for recovery" }, bearer);
    assert.equal(blocked.status, 409, await blocked.clone().text());
    assert.equal(ProblemSchema.parse(await blocked.json()).code, "PoolExhausted");
    assert.equal(side.holds("BoxTeardown"), false);

    const again = await side.next("SnapshotRequest");
    assert.equal(again.sessionId, sessionId);
    assert.equal(again.turnId, turnId);
    await storeRoot(again.storageKey);
    side.send({ type: "SnapshotDone", snapshotId: again.snapshotId, uploadedBytes: 14 });
    await until(
      "the second snapshot stored in place of the first",
      () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
      (snapshots) => snapshots.length === 1 && snapshots[0]?.snapshotId === again.snapshotId,
    );
    const replacement = await postJson(
      "/v1/sessions",
      { ...(await sessionStart()), prompt: "replace the recovered box" },
      bearer,
    );
    assert.equal(replacement.status, 200, await replacement.clone().text());
    assert.equal(StartedSessionSchema.parse(await replacement.json()).session.hostId, enrolled.id);
    assert.deepEqual(await side.next("BoxTeardown"), { type: "BoxTeardown", sessionId, boxId: offer.boxId });
    side.close();
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
    host.send({
      type: "TurnLine",
      turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"error_during_execution","is_error":false}',
    });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    await until(
      "the turn reading Failed",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Failed",
    );

    await tool("tumpel_session_stop", { sessionId }, SessionSchema);
    const warm = await host.next("SnapshotRequest");
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

  test("a finished turn reads Running until its snapshot is stored, and fails SnapshotNotStored, never Completed, when the host fails the snapshot", async () => {
    const { host, tool, sessionStart } = await tenant();
    await tool("tumpel_session_start", { ...(await sessionStart()), prompt: "lose my snapshot" }, StartedSessionSchema);
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result","subtype":"success","is_error":false}' });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    const request = await host.next("SnapshotRequest");
    assert.equal(request.turnId, turnId);
    assert.equal((await tool("tumpel_turn_get", { turnId }, TurnSchema)).state, "Running");

    host.send({
      type: "SnapshotFailed",
      snapshotId: request.snapshotId,
      reason: "UploadRejected",
      detail: "the store refused the upload",
      failedAt: new Date().toISOString(),
    });
    const failed = await until(
      "the turn reading Failed",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state !== "Running",
    );
    assert.equal(failed.state, "Failed");
    const failure = await tool("tumpel_turn_failure", { turnId }, TurnFailureSchema);
    assert.equal(failure.reason, "SnapshotNotStored");
    assert.match(failure.detail, /UploadRejected: the store refused the upload/);
  });

  test("a finished turn whose snapshot the host never answers fails SnapshotNotStored, never Completed", async () => {
    const { host, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "wait for my snapshot" },
      StartedSessionSchema,
    );
    const { sessionId, tenantId } = started.session;
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result","subtype":"success","is_error":false}' });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    assert.equal((await host.next("SnapshotRequest")).turnId, turnId);

    const at = Date.now() + 500;
    await storeTimers(sessionId, { tenantId, sessionId, deadlines: { SnapshotAnswer: { turnId, at } } }, at);
    const failed = await until(
      "the turn reading Failed",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state !== "Running",
    );
    assert.equal(failed.state, "Failed");
    const failure = await tool("tumpel_turn_failure", { turnId }, TurnFailureSchema);
    assert.equal(failure.reason, "SnapshotNotStored");
    assert.match(failure.detail, /did not answer a snapshot within 60 seconds/);
  });

  test("a finished turn whose host goes offline before its snapshot lands fails SnapshotNotStored, never Completed", async () => {
    const { host, tool, sessionStart } = await tenant();
    await tool("tumpel_session_start", { ...(await sessionStart()), prompt: "drop my host" }, StartedSessionSchema);
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result","subtype":"success","is_error":false}' });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    assert.equal((await host.next("SnapshotRequest")).turnId, turnId);

    host.close();
    await until(
      "the turn reading Failed",
      () => tool("tumpel_turn_get", { turnId }, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    const failure = await tool("tumpel_turn_failure", { turnId }, TurnFailureSchema);
    assert.equal(failure.reason, "SnapshotNotStored");
    assert.match(failure.detail, /went offline during the turn/);
  });

  test("a stop with cancelTurn while a finished turn awaits its snapshot fails it SnapshotNotStored, never Completed", async () => {
    const { host, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "cancel my snapshot" },
      StartedSessionSchema,
    );
    const offer = await host.next("TurnOffer");
    const { turnId } = offer;
    host.send({ type: "TurnClaim", turnId, boxId: offer.boxId });
    host.send({ type: "TurnLine", turnId, lineSeq: 1, text: '{"type":"result","subtype":"success","is_error":false}' });
    host.send({ type: "TurnComplete", turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    assert.equal((await host.next("SnapshotRequest")).turnId, turnId);

    await tool("tumpel_session_stop", { sessionId: started.session.sessionId, cancelTurn: true }, SessionSchema);
    assert.equal((await tool("tumpel_turn_get", { turnId }, TurnSchema)).state, "Failed");
    const failure = await tool("tumpel_turn_failure", { turnId }, TurnFailureSchema);
    assert.equal(failure.reason, "SnapshotNotStored");
    assert.match(failure.detail, /cancelled the turn/);
  });

  test("a snapshot learns where the tenant holds its chunks and uploads only new packs, a restore gets only its session's packs, and an archive keeps every pack", async () => {
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
    host.send({
      type: "TurnFailed",
      turnId: restoring.turnId,
      reason: "BoxBootFailed",
      detail: "the box did not boot",
      failedAt: new Date().toISOString(),
    });
    await until(
      "the restore turn reading Failed",
      () => getJson(`/v1/turns/${restoring.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    const afterRestore = await host.next("SnapshotRequest");
    assert.equal(afterRestore.turnId, restoring.turnId);
    host.send({
      type: "SnapshotFailed",
      snapshotId: afterRestore.snapshotId,
      reason: "BoxNotFound",
      detail: "this host runs no box of the session",
      failedAt: new Date().toISOString(),
    });

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
    host.send({
      type: "TurnFailed",
      turnId: reusing.turnId,
      reason: "BoxBootFailed",
      detail: "the box did not boot",
      failedAt: new Date().toISOString(),
    });
    await until(
      "the shared restore turn reading Failed",
      () => getJson(`/v1/turns/${reusing.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    const afterReuse = await host.next("SnapshotRequest");
    assert.equal(afterReuse.turnId, reusing.turnId);
    host.send({
      type: "SnapshotFailed",
      snapshotId: afterReuse.snapshotId,
      reason: "BoxNotFound",
      detail: "this host runs no box of the session",
      failedAt: new Date().toISOString(),
    });

    await tool("tumpel_session_stop", { sessionId: first.session.sessionId }, SessionSchema);
    const atStop = await host.next("SnapshotRequest");
    assert.equal(atStop.turnId, restoring.turnId);
    host.send({
      type: "SnapshotFailed",
      snapshotId: atStop.snapshotId,
      reason: "BoxNotFound",
      detail: "this host runs no box of the session",
      failedAt: new Date().toISOString(),
    });
    const teardown = await host.next("BoxTeardown");
    host.send({ type: "BoxGone", sessionId: first.session.sessionId, boxId: teardown.boxId });
    await until(
      "the session reading Stopped",
      () => tool("tumpel_session_get", { sessionId: first.session.sessionId }, SessionSchema),
      (session) => session.state === "Stopped",
    );
    await tool("tumpel_session_archive", { sessionId: first.session.sessionId }, SessionSchema);
    assert.notEqual(await store.text(`${tenantId}/packs/${packOne}`), null);
    assert.notEqual(await store.text(`${tenantId}/packs/${packTwo}`), null);
    assert.notEqual(await store.text(`${tenantId}/packs/${packThree}`), null);

    const third = await completedTurn("chunk the third");
    const again = await storedChunks(third.session.sessionId, [one, two], {});
    assert.deepEqual(
      again.held.map((placement) => placement.digest),
      [one, two],
    );
    assert.deepEqual(again.uploaded, []);
  });

  test("a stored snapshot deletes the session's older root and keeps the packs its chunks lie in", async () => {
    const { host, tool, completedTurn, storedChunks } = await tenant();
    const [one, two] = ["1", "2"].map((digit) => digit.repeat(64)) as [string, string];
    const [packOne, packTwo] = ["a", "b"].map((digit) => digit.repeat(64)) as [string, string];
    const first = await completedTurn("snapshot the first");
    const { sessionId } = first.session;
    const older = await storedChunks(sessionId, [one], { [packOne]: [one] });
    const tenantId = older.request.storageKey.split("/")[0] ?? "";

    await tool("tumpel_turn_send", { sessionId, prompt: "snapshot the second" }, TurnSchema);
    const offer = await host.next("TurnOffer");
    const lineSeq = offer.lastLineSeq + 1;
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    host.send({
      type: "TurnLine",
      turnId: offer.turnId,
      lineSeq,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    host.send({
      type: "TurnComplete",
      turnId: offer.turnId,
      lastLineSeq: lineSeq,
      completedAt: new Date().toISOString(),
    });
    const newer = await storedChunks(sessionId, [two], { [packTwo]: [two] });
    await until(
      "the older snapshot gone",
      () => tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
      (snapshots) => snapshots.length === 1 && snapshots[0]?.snapshotId === newer.request.snapshotId,
    );
    assert.equal(await store.text(older.request.storageKey), null);
    assert.notEqual(await store.text(`${tenantId}/packs/${packOne}`), null);
  });

  test("a snapshot whose manifest lists 140000 chunks is stored", async () => {
    const { host, tool, completedTurn } = await tenant();
    const { offer } = await completedTurn("snapshot a large tree");
    const request = await host.next("SnapshotRequest");
    const digests = Array.from({ length: 140_000 }, (_, index) =>
      createHash("sha256").update(String(index)).digest("hex"),
    );
    await storeRoot(request.storageKey, digests);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 5614295885 });
    await until(
      "the snapshotted turn reading Completed",
      () => tool("tumpel_turn_get", { turnId: offer.turnId }, TurnSchema),
      (turn) => turn.state === "Completed",
    );
    host.assertOpen("after the large snapshot");
  });

  test("a host frame whose handling throws is refused with the error and the channel carries the next frame", async () => {
    const { host, tool, completedTurn } = await tenant();
    const { offer } = await completedTurn("snapshot with an unreadable root");
    const request = await host.next("SnapshotRequest");
    await store.put(request.storageKey, JSON.stringify({ manifest: "not a list" }));
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 64 });
    const refused = await host.refusal();
    assert.equal(refused.seq, host.carried().sent);
    assert.ok((await storedTimers(request.sessionId))?.deadlines.SnapshotAnswer);
    assert.match(refused.reason, /failed to handle SnapshotDone: .*manifest/);

    host.send({
      type: "SnapshotFailed",
      snapshotId: request.snapshotId,
      reason: "UploadRejected",
      detail: "the root is unreadable",
      failedAt: new Date().toISOString(),
    });
    await until(
      "the snapshotted turn failing",
      () => tool("tumpel_turn_get", { turnId: offer.turnId }, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    host.assertOpen("after the refusal");
  });

  test("a turn whose host goes offline before claiming it stays Offered, is offered again at the next Welcome and runs", async () => {
    const { bearer, getJson, enrol, sessionStart, hostState } = await tenant();
    const flaky = await enrol("flaky");
    const before = await connect(flaky.id, flaky.key, 16);
    await hostState(flaky.id, "Online");
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "across a reset" }, bearer);
    assert.equal(response.status, 200);
    const started = StartedSessionSchema.parse(await response.json());
    assert.equal(started.session.hostId, flaky.id);
    assert.equal((await before.next("TurnOffer")).turnId, started.turn.turnId);
    before.close();
    await hostState(flaky.id, "Offline");
    await wait((Math.max(SETTINGS.heartbeatDeadlineSeconds, OFFER_TTL_SECONDS) + 1) * 1000);
    assert.equal((await getJson(`/v1/turns/${started.turn.turnId}`, TurnSchema)).state, "Offered");

    const after = await connect(flaky.id, flaky.key, 16);
    const offer = await after.next("TurnOffer");
    assert.equal(offer.turnId, started.turn.turnId);
    after.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await after.next("TurnClaimed")).turnId, offer.turnId);
    assert.equal((await getJson(`/v1/turns/${offer.turnId}`, TurnSchema)).state, "Running");
    after.close();
  });

  test("a turn the host reports NotClaimed after its claim is offered again and runs on the next claim", async () => {
    const { bearer, host, getJson, sessionStart } = await tenant();
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "claim lost" }, bearer);
    assert.equal(response.status, 200);
    const started = StartedSessionSchema.parse(await response.json());
    const offer = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    await host.next("TurnClaimed");
    host.send({
      type: "TurnFailed",
      turnId: offer.turnId,
      reason: "NotClaimed",
      detail: "the control plane did not answer the claim in time",
      failedAt: new Date().toISOString(),
    });

    const again = await host.next("TurnOffer");
    assert.equal(again.turnId, started.turn.turnId);
    assert.equal((await getJson(`/v1/turns/${offer.turnId}`, TurnSchema)).state, "Offered");
    host.send({ type: "TurnClaim", turnId: again.turnId, boxId: again.boxId });
    assert.equal((await host.next("TurnClaimed")).turnId, offer.turnId);
    assert.equal((await getJson(`/v1/turns/${offer.turnId}`, TurnSchema)).state, "Running");
  });

  test("a turn no host claims by its whole-turn deadline dead-letters Undelivered on turn and session reads, also from a timer stored before its owner field was dropped", async () => {
    const { bearer, host, getJson, sessionStart } = await tenant();
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "never claimed" }, bearer);
    assert.equal(response.status, 200);
    const started = StartedSessionSchema.parse(await response.json());
    const offer = await host.next("TurnOffer");
    const { sessionId, tenantId } = started.session;
    const at = Date.now() + 500;
    await storeTimers(sessionId, { tenantId, sessionId, deadlines: { Total: { turnId: offer.turnId, at } } }, at);

    const failed = await until(
      "the turn reading Failed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    const failure = await getJson(`/v1/turns/${offer.turnId}/failure`, TurnFailureSchema);
    assert.equal(failure.reason, "Undelivered");
    assert.match(
      failure.detail,
      /^no host took the turn within 60 seconds of its first offer, so it never ran; host box is online but never claimed it\./,
    );
    assert.doesNotMatch(failure.detail, UUID);
    const read = FailedTurnSchema.parse(failed);
    assert.deepEqual(
      { reason: read.reason, detail: read.detail, failedAt: read.failedAt },
      { reason: failure.reason, detail: failure.detail, failedAt: failure.failedAt },
    );
    const session = await getJson(`/v1/sessions/${sessionId}`, SessionSchema);
    assert.deepEqual(session.lastTurn, read);
  });

  test("a first turn that fails before its box exists leaves the session Stopped, and the next turn gets a new box", async () => {
    const { bearer, host, getJson, sessionStart } = await tenant();
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "never claimed" }, bearer);
    assert.equal(response.status, 200);
    const started = StartedSessionSchema.parse(await response.json());
    const offer = await host.next("TurnOffer");
    const { sessionId, tenantId } = started.session;
    const at = Date.now() + 500;
    await storeTimers(sessionId, { tenantId, sessionId, deadlines: { Total: { turnId: offer.turnId, at } } }, at);

    await until(
      "the turn reading Failed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    assert.equal((await getJson(`/v1/sessions/${sessionId}`, SessionSchema)).state, "Stopped");
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await host.next("TurnWithdrawn")).turnId, offer.turnId);
    assert.deepEqual(await host.next("BoxDiscard"), { type: "BoxDiscard", sessionId, boxId: offer.boxId });

    const sent = await postJson(`/v1/sessions/${sessionId}/turns`, { prompt: "again" }, bearer);
    assert.equal(sent.status, 200, await sent.clone().text());
    const again = await host.next("TurnOffer");
    assert.equal(again.sessionId, sessionId);
    assert.notEqual(again.boxId, offer.boxId);
  });

  test("a turn whose harness exits without a successful result fails HarnessExitedWithoutResult on every read, and a snapshot of its box follows", async () => {
    const { bearer, host, getJson, tool, sessionStart } = await tenant();
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "stops mid-work" }, bearer);
    assert.equal(response.status, 200);
    const { session } = StartedSessionSchema.parse(await response.json());
    const offer = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    host.send({
      type: "TurnLine",
      turnId: offer.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"error_during_execution","is_error":false}',
    });
    host.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });

    const request = await host.next("SnapshotRequest");
    assert.equal(request.turnId, offer.turnId);
    assert.equal(request.boxId, offer.boxId);
    const read = await getJson(`/v1/turns/${offer.turnId}`, FailedTurnSchema);
    assert.equal(read.reason, "HarnessExitedWithoutResult");
    assert.match(read.detail, /exited without printing a successful result/);
    assert.deepEqual(await tool("tumpel_turn_get", { turnId: offer.turnId }, TurnSchema), read);
    assert.deepEqual(await getJson(`/v1/sessions/${session.sessionId}/turns`, TurnSchema.array()), [read]);
    assert.deepEqual((await getJson(`/v1/sessions/${session.sessionId}`, SessionSchema)).lastTurn, read);
  });

  test("a turn wait over MCP answers when the first of several turns ends, with every turn's state and a failed turn's reason", async () => {
    const { host, tool, toolRefusal, sessionStart } = await tenant();
    const running = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "keeps running" },
      StartedSessionSchema,
    );
    const offer = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await host.next("TurnClaimed")).turnId, running.turn.turnId);
    const unclaimed = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "never claimed" },
      StartedSessionSchema,
    );
    const unclaimedOffer = await host.next("TurnOffer");
    const { sessionId, tenantId } = unclaimed.session;
    const at = Date.now() + 500;
    await storeTimers(
      sessionId,
      { tenantId, sessionId, deadlines: { Total: { turnId: unclaimedOffer.turnId, at } } },
      at,
    );

    const firstWait = Date.now();
    const failed = await tool(
      "tumpel_turn_wait",
      { turnId: [running.turn.turnId, unclaimed.turn.turnId], timeoutSeconds: 50 },
      TurnSchema.array(),
    );
    assert.ok(Date.now() - firstWait < 20_000);
    assert.deepEqual(
      failed.map((turn) => [turn.turnId, turn.state]),
      [
        [running.turn.turnId, "Running"],
        [unclaimed.turn.turnId, "Failed"],
      ],
    );
    assert.equal(
      (await tool("tumpel_turn_failure", { turnId: unclaimed.turn.turnId }, TurnFailureSchema)).reason,
      "Undelivered",
    );

    const timedOut = await tool(
      "tumpel_turn_wait",
      { turnId: [running.turn.turnId], timeoutSeconds: 1 },
      TurnSchema.array(),
    );
    assert.deepEqual(
      timedOut.map((turn) => turn.state),
      ["Running"],
    );

    const secondWait = Date.now();
    const waiting = tool("tumpel_turn_wait", { turnId: [running.turn.turnId], timeoutSeconds: 50 }, TurnSchema.array());
    await wait(500);
    host.send({
      type: "TurnLine",
      turnId: offer.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    host.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    let snapshot = await host.next("SnapshotRequest");
    while (snapshot.turnId !== offer.turnId) snapshot = await host.next("SnapshotRequest");
    await storeRoot(snapshot.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: snapshot.snapshotId, uploadedBytes: 14 });
    const completed = await waiting;
    assert.ok(Date.now() - secondWait < 20_000);
    assert.deepEqual(
      completed.map((turn) => [turn.turnId, turn.state]),
      [[running.turn.turnId, "Completed"]],
    );

    assert.match(
      await toolRefusal("tumpel_turn_wait", { turnId: [running.turn.turnId, "no-such-turn"], timeoutSeconds: 1 }),
      /your tenant has no turn no-such-turn/,
    );
  });

  test("tenant events record a turn's start, completion and the idle session in order, wake an MCP wait and stream over a WebSocket, also to a browser that sends its token as a subprotocol", async () => {
    const { tenantId, bearer, host, tool, toolRefusal, sessionStart } = await tenant();
    const start = await tool("tumpel_events_wait", { waitSeconds: 0 }, EventPageSchema);
    assert.deepEqual(start.events, []);

    const socket = new WebSocket(
      `${origin.replace(/^http/, "ws")}/v1/events?waitSeconds=0&afterEventId=${start.lastEventId}&event=TurnCompleted`,
      { headers: bearer } as unknown as string[],
    );
    const streamed = new Promise<unknown>((resolve) => {
      socket.addEventListener("message", (message) => resolve(JSON.parse(String(message.data))));
    });
    await new Promise((resolve) => socket.addEventListener("open", resolve));
    const browser = new WebSocket(`${origin.replace(/^http/, "ws")}/v1/events?waitSeconds=0&event=TurnCompleted`, {
      protocols: ["tumpel.bearer", `tumpel.bearer.${bearer.authorization.slice("Bearer ".length)}`],
      headers: { origin: "https://app.tumpel.test" },
    } as unknown as string[]);
    const browserStreamed = new Promise<unknown>((resolve) => {
      browser.addEventListener("message", (message) => resolve(JSON.parse(String(message.data))));
    });
    await new Promise((resolve) => browser.addEventListener("open", resolve));
    assert.equal(browser.protocol, "tumpel.bearer");

    const waiting = tool(
      "tumpel_events_wait",
      { afterEventId: start.lastEventId, event: ["TurnCompleted"], waitSeconds: 50 },
      EventPageSchema,
    );
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "events" },
      StartedSessionSchema,
    );
    const offer = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    await host.next("TurnClaimed");
    await wait(500);
    host.send({
      type: "TurnLine",
      turnId: offer.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    host.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    const snapshot = await host.next("SnapshotRequest");
    await storeRoot(snapshot.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: snapshot.snapshotId, uploadedBytes: 14 });

    const woken = await waiting;
    assert.deepEqual(
      woken.events.map((event) => event.event),
      ["TurnCompleted"],
    );
    const pushed = TenantEventSchema.parse(await streamed);
    assert.equal(pushed.event, "TurnCompleted");
    assert.equal("turnId" in pushed && pushed.turnId, started.turn.turnId);
    assert.deepEqual(TenantEventSchema.parse(await browserStreamed), pushed);
    socket.close();
    browser.close();

    const { sessionId } = started.session;
    const all = await tool(
      "tumpel_events_wait",
      { afterEventId: start.lastEventId, sessionId, waitSeconds: 0 },
      EventPageSchema,
    );
    assert.deepEqual(
      all.events.map((event) => event.event),
      ["TurnStarted", "TurnCompleted", "SessionIdle"],
    );
    assert.deepEqual(
      (await tool("tumpel_events_wait", { afterEventId: all.lastEventId, sessionId, waitSeconds: 0 }, EventPageSchema))
        .events,
      [],
    );
    assert.match(await toolRefusal("tumpel_events_wait", { waitSeconds: 51 }), /waitSeconds/);

    const first = all.events[0];
    const second = all.events[1];
    assert.ok(first && second);
    await tenantSql(tenantId, "DELETE FROM events WHERE event_id <= ?", first.eventId);
    for (const headers of [bearer, { ...bearer, upgrade: "websocket" }]) {
      const expired = await call(`/v1/events?waitSeconds=0&afterEventId=${start.lastEventId}`, { headers });
      assert.equal(expired.status, 410);
      assert.equal(EventCursorExpiredProblemSchema.parse(await expired.json()).oldestEventId, second.eventId);
    }
  });

  test("a start from an issue over MCP refuses a missing or closed issue, and an open one offers its prompt and reads back the issue", async () => {
    const { bearer, host, tool, toolRefusal, sessionStart, getJson } = await tenant();
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
    const { sessionId } = started.session;
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

    const { sessionId: _parent, ...issued } = issue;
    const origin = { kind: "Issue", ...issued };
    assert.deepEqual((await tool("tumpel_session_get", { sessionId }, SessionSchema)).origin, origin);
    const listed = await getJson("/v1/sessions", SessionSchema.array());
    assert.deepEqual(
      listed.map((session) => [session.sessionId, session.origin]),
      [[sessionId, origin]],
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

  test("the first heartbeat after a reconnect fails BoxLost each Running turn whose box the host no longer holds, after the turns its resent frames settle", async () => {
    const { bearer, host, hostId, getJson, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const lost = await enrol("lost");
    const first = await connect(lost.id, lost.key);
    await hostState(lost.id, "Online");
    const claimed = async (prompt: string) => {
      const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt }, bearer);
      assert.equal(response.status, 200, await response.clone().text());
      const { session } = StartedSessionSchema.parse(await response.json());
      const offer = await first.next("TurnOffer");
      first.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
      await first.next("TurnClaimed");
      return { sessionId: session.sessionId, turnId: offer.turnId };
    };
    const held = await claimed("box survives");
    const gone = await claimed("box goes away");
    const finished = await claimed("finished while disconnected");

    first.close();
    await hostState(lost.id, "Offline");
    const back = await connect(
      lost.id,
      lost.key,
      8,
      { ...first.carried(), held: [held.sessionId, finished.sessionId] },
      [
        {
          type: "TurnLine",
          turnId: finished.turnId,
          lineSeq: 1,
          text: '{"type":"result","subtype":"success","is_error":false}',
        },
        { type: "TurnComplete", turnId: finished.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() },
      ],
    );
    await until(
      "the turn whose box is gone failing",
      () => getJson(`/v1/turns/${gone.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    const failure = await getJson(`/v1/turns/${gone.turnId}/failure`, TurnFailureSchema);
    assert.equal(failure.reason, "BoxLost");
    assert.match(failure.detail, /^host lost reconnected without the box that ran the turn/);
    assert.equal((await getJson(`/v1/turns/${held.turnId}`, TurnSchema)).state, "Running");
    const snapshot = await back.next("SnapshotRequest");
    assert.equal(snapshot.turnId, finished.turnId);
    await storeRoot(snapshot.storageKey);
    back.send({ type: "SnapshotDone", snapshotId: snapshot.snapshotId, uploadedBytes: 14 });
    await until(
      "the finished turn reading Completed",
      () => getJson(`/v1/turns/${finished.turnId}`, TurnSchema),
      (turn) => turn.state === "Completed",
    );
    const session = await getJson(`/v1/sessions/${gone.sessionId}`, SessionSchema);
    assert.equal(session.state, "Idle");
    assert.equal(session.lastTurnState, "Failed");

    const sent = await postJson(`/v1/sessions/${gone.sessionId}/turns`, { prompt: "again" }, bearer);
    assert.equal(sent.status, 200, await sent.clone().text());
    const next = TurnSchema.parse(await sent.json());
    assert.equal((await back.next("TurnOffer")).turnId, next.turnId);
    back.close();
  });

  test("a finished turn whose host reconnects without its box before a snapshot holds it fails SnapshotNotStored, never Completed, and the session takes its next turn", async () => {
    const { bearer, host, hostId, getJson, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const lost = await enrol("lost");
    const first = await connect(lost.id, lost.key);
    await hostState(lost.id, "Online");
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "unsnapshotted" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const { session } = StartedSessionSchema.parse(await response.json());
    const offer = await first.next("TurnOffer");
    first.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    first.send({
      type: "TurnLine",
      turnId: offer.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    first.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    assert.equal((await first.next("SnapshotRequest")).sessionId, session.sessionId);
    assert.equal((await getJson(`/v1/turns/${offer.turnId}`, TurnSchema)).state, "Running");

    first.close();
    await hostState(lost.id, "Offline");
    const back = await connect(lost.id, lost.key, 8, { ...first.carried(), held: [] });
    const failed = await until(
      "the finished turn whose box is gone failing",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state !== "Running",
    );
    assert.equal(failed.state, "Failed");
    const failure = await getJson(`/v1/turns/${offer.turnId}/failure`, TurnFailureSchema);
    assert.equal(failure.reason, "SnapshotNotStored");
    assert.match(failure.detail, /reconnected without the box/);
    const sent = await postJson(`/v1/sessions/${session.sessionId}/turns`, { prompt: "again" }, bearer);
    assert.equal(sent.status, 200, await sent.clone().text());
    const next = TurnSchema.parse(await sent.json());
    assert.equal((await back.next("TurnOffer")).turnId, next.turnId);
    back.close();
  });

  test("a session moves off its offline host once a snapshot completes its last turn, and the old host's late frames leave its channel working", async () => {
    const { bearer, getJson, enrol, sessionStart, hostState } = await tenant();
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
    from.send({
      type: "TurnLine",
      turnId: offer.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    from.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    const request = await from.next("SnapshotRequest");

    from.close();
    await hostState(first.id, "Offline");

    from = await connect(first.id, first.key, 16, from.carried());
    await hostState(first.id, "Online");
    await storeRoot(request.storageKey);
    from.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
    await until(
      "a stored snapshot",
      () => getJson(`/v1/sessions/${sessionId}/snapshots`, SnapshotSchema.array()),
      (snapshots) => snapshots.length === 1,
    );
    await until(
      "the turn reading Completed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Completed",
    );
    const claimed = await postJson(`/v1/sessions/${sessionId}/turns`, { prompt: "lost with its host" }, bearer);
    assert.equal(claimed.status, 200, await claimed.clone().text());
    const lost = TurnSchema.parse(await claimed.json());
    assert.equal((await from.next("TurnOffer")).turnId, lost.turnId);
    from.send({ type: "TurnClaim", turnId: lost.turnId, boxId: offer.boxId });
    await from.next("TurnClaimed");
    from.close();
    await hostState(first.id, "Offline");
    await until(
      "the claimed turn reading Failed",
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

    from = await connect(first.id, first.key, 16, from.carried());
    await hostState(first.id, "Online");
    const discard = await from.next("BoxDiscard");
    assert.deepEqual({ sessionId: discard.sessionId, boxId: discard.boxId }, { sessionId, boxId: offer.boxId });
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
    assert.equal((await getJson(`/v1/turns/${lost.turnId}/failure`, TurnFailureSchema)).reason, "HostOffline");
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

  test("a host frame the tenant cannot place is refused by name and the channel carries the next turn", async () => {
    const { bearer, host, sessionStart } = await tenant();
    const stray = crypto.randomUUID();
    host.send({ type: "TurnClaim", turnId: stray, boxId: crypto.randomUUID() });
    const refused = await host.refusal();
    assert.equal(refused.seq, host.carried().sent);
    assert.match(refused.reason, new RegExp(`sent TurnClaim for turn ${stray}, which is not offered to it`));

    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "after the refusal" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const offer = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await host.next("TurnClaimed")).turnId, offer.turnId);
    host.assertOpen("after the refusal");
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
    const swapped = await connect(only.id, only.key, 32, swapping.carried());
    const offer = await swapped.next("TurnOffer");
    assert.equal(offer.turnId, turn.turnId);
    swapped.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await swapped.next("TurnClaimed")).turnId, turn.turnId);
    assert.equal((await getJson(`/v1/turns/${turn.turnId}`, TurnSchema)).state, "Running");
    swapped.close();
  });

  test("a claimed turn whose box a handover keeps warm is offered again to the same host in the same box, not to another host", async () => {
    const { bearer, getJson, enrol, sessionStart, hostState } = await tenant();
    const first = await enrol("handover-1");
    const second = await enrol("handover-2");
    const sides = new Map([
      [first.id, await connect(first.id, first.key, 32)],
      [second.id, await connect(second.id, second.key, 32)],
    ]);
    await hostState(first.id, "Online");
    await hostState(second.id, "Online");
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "across a handover" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const started = StartedSessionSchema.parse(await response.json());
    const handing = started.session.hostId;
    const before = sides.get(handing);
    assert.ok(before);
    const offer = await before.next("TurnOffer");
    before.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    await until(
      "the control plane taking the claim",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Running",
    );
    before.close();
    const after = await connect(
      handing,
      handing === first.id ? first.key : second.key,
      32,
      { ...before.carried(), held: [started.session.sessionId] },
      [
        {
          type: "TurnFailed",
          turnId: offer.turnId,
          reason: "HostUpdating",
          detail: `this host started handing its boxes to a new supervisor binary before the control plane answered the claim of turn ${offer.turnId}, so its harness never started and its box stays warm; the control plane offers the turn again`,
          failedAt: new Date().toISOString(),
        },
      ],
    );
    const again = await after.next("TurnOffer");
    assert.deepEqual({ turnId: again.turnId, boxId: again.boxId }, { turnId: offer.turnId, boxId: offer.boxId });
    const session = await getJson(`/v1/sessions/${started.session.sessionId}`, SessionSchema);
    assert.deepEqual({ hostId: session.hostId, boxId: session.boxId }, { hostId: handing, boxId: offer.boxId });
    assert.equal((await getJson(`/v1/turns/${offer.turnId}`, TurnSchema)).state, "Offered");
    after.close();
    for (const side of sides.values()) side.close();
  });

  test("a claimed turn whose box a handover keeps warm on the only host is offered again in the same box on the new binary's first heartbeat, which does not call it lost", async () => {
    const { bearer, host, hostId, getJson, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const only = await enrol("handover-only");
    const before = await connect(only.id, only.key, 32);
    await hostState(only.id, "Online");
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "across a handover" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const { session, turn } = StartedSessionSchema.parse(await response.json());
    const offer = await before.next("TurnOffer");
    before.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    await until(
      "the control plane taking the claim",
      () => getJson(`/v1/turns/${turn.turnId}`, TurnSchema),
      (read) => read.state === "Running",
    );
    before.close();
    const after = await connect(only.id, only.key, 32, { ...before.carried(), held: [session.sessionId] }, [
      {
        type: "TurnFailed",
        turnId: turn.turnId,
        reason: "HostUpdating",
        detail: `this host started handing its boxes to a new supervisor binary before the control plane answered the claim of turn ${turn.turnId}, so its harness never started and its box stays warm; the control plane offers the turn again`,
        failedAt: new Date().toISOString(),
      },
    ]);
    const again = await after.next("TurnOffer");
    assert.deepEqual({ turnId: again.turnId, boxId: again.boxId }, { turnId: turn.turnId, boxId: offer.boxId });
    after.send({ type: "TurnClaim", turnId: again.turnId, boxId: again.boxId });
    assert.equal((await after.next("TurnClaimed")).turnId, turn.turnId);
    assert.equal((await getJson(`/v1/turns/${turn.turnId}`, TurnSchema)).state, "Running");
    after.close();
  });

  test("a turn completed on a nearly full box disk stays Completed and its turn and session reads carry the warning", async () => {
    const { bearer, host, getJson, sessionStart } = await tenant();
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "build it all" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const { session } = StartedSessionSchema.parse(await response.json());
    const offer = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    await host.next("TurnClaimed");
    const warning =
      "the box disk of 32096 MiB is full, 12 MiB free; give the persona a larger boxDiskMib, up to 262144 MiB, or have it delete build output it no longer needs";
    host.send({
      type: "TurnLine",
      turnId: offer.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    host.send({
      type: "TurnComplete",
      turnId: offer.turnId,
      lastLineSeq: 1,
      completedAt: new Date().toISOString(),
      warning,
    });
    const snapshot = await host.next("SnapshotRequest");
    await storeRoot(snapshot.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: snapshot.snapshotId, uploadedBytes: 14 });
    const turn = await until(
      "the turn reading Completed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (read) => read.state === "Completed",
    );
    assert.equal(turn.state === "Completed" ? turn.warning : undefined, warning);
    const { lastTurn } = await getJson(`/v1/sessions/${session.sessionId}`, SessionSchema);
    assert.equal(lastTurn.state === "Completed" ? lastTurn.warning : undefined, warning);
  });

  test("a persona's box disk reads back, a host without disk room refuses its session by name, and every offer carries it", async () => {
    const { bearer, host, getJson } = await tenant();
    const [persona] = await getJson("/v1/personas", PersonaSchema.array());
    assert.ok(persona);
    const sized = async (boxDiskMib: number) => {
      const written = await server.fetch(`${origin}/v1/personas/${persona.personaId}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...bearer },
        body: JSON.stringify({
          name: persona.name,
          secretSetId: persona.secretSetId,
          connectorIds: [],
          boxDiskMib,
          files: [],
        }),
      });
      assert.equal(written.status, 200, await written.clone().text());
      assert.equal((await getJson(`/v1/personas/${persona.personaId}`, PersonaSchema)).boxDiskMib, boxDiskMib);
      return postJson(
        "/v1/sessions",
        {
          repository: "https://github.com/acme/app.git",
          model: "claude-sonnet-5-5",
          personaId: persona.personaId,
          prompt: "build every repo",
        },
        bearer,
      );
    };
    const refused = await sized(262144);
    assert.equal(refused.status, 409);
    assert.match(
      ProblemSchema.parse(await refused.json()).detail,
      /gives box disks 200000 MiB and its boxes hold 32768 MiB of it, and the persona's boxes need 262144 MiB/,
    );
    const response = await sized(131072);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await host.next("TurnOffer")).boxDiskMib, 131072);
  });

  test("a persona created without box memory reads 2048 MiB, takes 512 MiB, and is refused 511 MiB by name", async () => {
    const { bearer, host, getJson, sessionStart } = await tenant();
    const [persona] = await getJson("/v1/personas", PersonaSchema.array());
    assert.ok(persona);
    assert.equal(persona.boxMemoryMib, 2048);
    const sized = (boxMemoryMib: number) =>
      server.fetch(`${origin}/v1/personas/${persona.personaId}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...bearer },
        body: JSON.stringify({
          name: persona.name,
          secretSetId: persona.secretSetId,
          connectorIds: [],
          boxMemoryMib,
          files: [],
        }),
      });
    const refused = await sized(511);
    assert.equal(refused.status, 400);
    const refusal = ProblemSchema.parse(await refused.json());
    assert.equal(refusal.code, "InvalidRequest");
    assert.match(refusal.detail, /boxMemoryMib/);
    const small = await sized(512);
    assert.equal(small.status, 200, await small.clone().text());
    assert.equal((await getJson(`/v1/personas/${persona.personaId}`, PersonaSchema)).boxMemoryMib, 512);
    const started = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "small job" }, bearer);
    assert.equal(started.status, 200, await started.clone().text());
    assert.equal((await host.next("TurnOffer")).boxMemoryMib, 512);
  });

  test("a turn the only host keeps refusing PoolExhausted ends Undelivered at its first offer's deadline, naming the refusal", async () => {
    const { bearer, host, getJson, sessionStart } = await tenant();
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "never fits" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const { session, turn } = StartedSessionSchema.parse(await response.json());
    await tenantSql(
      session.tenantId,
      "UPDATE turns SET created_at = ? WHERE turn_id = ?",
      Date.now() - (SETTINGS.turnTotalBudgetSeconds - 2) * 1000,
      turn.turnId,
    );
    const refusal =
      "this host gives box disks 70000 MiB, its 80000 MiB of free disk and the 0 MiB its boxes wrote less the 10000 MiB it keeps free; its 2 boxes hold 65536 MiB of it, so a box disk of 32768 MiB does not fit; free disk on the host, or lower the persona's boxDiskMib";
    const refuse = (turnId: string): void =>
      host.send({
        type: "TurnFailed",
        turnId,
        reason: "PoolExhausted",
        detail: refusal,
        failedAt: new Date().toISOString(),
      });
    refuse((await host.next("TurnOffer")).turnId);
    refuse((await host.next("TurnOffer")).turnId);
    await until(
      "the turn reading Failed",
      () => getJson(`/v1/turns/${turn.turnId}`, TurnSchema),
      (read) => read.state === "Failed",
    );
    const failure = await getJson(`/v1/turns/${turn.turnId}/failure`, TurnFailureSchema);
    assert.equal(failure.reason, "Undelivered");
    assert.ok(failure.detail.endsWith(`last refused it: ${refusal}`), failure.detail);
  });

  test("a turn a host refuses PoolExhausted goes to an idle host on the refusing host's next heartbeat, in a new box", async () => {
    const { bearer, host, hostId, getJson, enrol, sessionStart, hostState } = await tenant();
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "too big here" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const { session, turn } = StartedSessionSchema.parse(await response.json());
    assert.equal(session.hostId, hostId);
    const idle = await enrol("idle-host");
    const idleSide = await connect(idle.id, idle.key, 32);
    await hostState(idle.id, "Online");
    const offer = await host.next("TurnOffer");
    host.send({
      type: "TurnFailed",
      turnId: offer.turnId,
      reason: "PoolExhausted",
      detail:
        "this host has 2048 MiB of memory available and keeps 14848 MiB of it free, so a box of 4096 MiB does not fit now",
      failedAt: new Date().toISOString(),
    });
    const moved = await idleSide.next("TurnOffer");
    assert.equal(moved.turnId, turn.turnId);
    assert.notEqual(moved.boxId, offer.boxId);
    const read = await getJson(`/v1/sessions/${session.sessionId}`, SessionSchema);
    assert.deepEqual({ hostId: read.hostId, boxId: read.boxId }, { hostId: idle.id, boxId: moved.boxId });
    idleSide.send({ type: "TurnClaim", turnId: moved.turnId, boxId: moved.boxId });
    assert.equal((await idleSide.next("TurnClaimed")).turnId, turn.turnId);
    idleSide.close();
  });

  test("a turn the only host refuses PoolExhausted stays Offered and is offered again on a later heartbeat", async () => {
    const { bearer, host, hostId, getJson, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const only = await enrol("short-of-memory");
    const side = await connect(only.id, only.key, 32);
    await hostState(only.id, "Online");
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "under pressure" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const { turn } = StartedSessionSchema.parse(await response.json());
    assert.equal((await side.next("TurnOffer")).turnId, turn.turnId);
    side.send({
      type: "TurnFailed",
      turnId: turn.turnId,
      reason: "PoolExhausted",
      detail:
        "this host has 2048 MiB of memory available and keeps 14848 MiB of it free, so a box of 4096 MiB does not fit now",
      failedAt: new Date().toISOString(),
    });
    const offer = await side.next("TurnOffer");
    assert.equal(offer.turnId, turn.turnId);
    assert.equal((await getJson(`/v1/turns/${turn.turnId}`, TurnSchema)).state, "Offered");
    side.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await side.next("TurnClaimed")).turnId, turn.turnId);
    assert.equal((await getJson(`/v1/turns/${turn.turnId}`, TurnSchema)).state, "Running");
    side.close();
  });

  test("a trigger fired while every host is full queues its session, and the first host to report room takes it", async () => {
    const { tenantId, bearer, host, hostId, getJson, enrol, sessionStart, hostState } = await tenant();
    await installPrebuiltApp(tenantId);
    host.close();
    await hostState(hostId, "Offline");
    const box = BoxMemoryLimit.DefaultMib;
    const sides = new Map<string, HostSide>();
    for (const name of ["full-a", "full-b"]) {
      const full = await enrol(name);
      const side = await connect(full.id, full.key, 8, undefined, undefined, {
        ...USAGE,
        memoryBudgetMib: box,
        memoryHeldMib: box,
      });
      await hostState(full.id, "Online");
      side.quiet();
      sides.set(full.id, side);
    }
    const { personaId, model } = await sessionStart();
    const created = await postJson(
      "/v1/triggers",
      {
        name: "agent-review",
        source: { kind: "GitHub", event: "status", conditions: [{ field: "context", values: ["agent-review"] }] },
        personaId,
        model,
        prompt: "Review {{target_url}} at {{sha}}",
      },
      bearer,
    );
    assert.equal(created.status, 200, await created.clone().text());
    const { triggerId } = TriggerSchema.parse(await created.json());
    const body = JSON.stringify({
      installation: { id: 77 },
      repository: { html_url: "https://github.com/acme/app" },
      context: "agent-review",
      state: "pending",
      sha: "c".repeat(40),
      target_url: "https://github.com/acme/app/pull/7",
    });
    const delivered = await call("/github/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "status",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", "sessions-webhook-secret").update(body).digest("hex")}`,
      },
      body,
    });
    assert.equal(delivered.status, 204, await delivered.clone().text());
    const [queued] = await getJson(`/v1/sessions?triggerId=${triggerId}`, SessionSchema.array());
    assert.ok(queued, "the trigger started no session");
    assert.deepEqual(
      { state: queued.lastTurn.state, prompt: queued.lastTurn.prompt },
      { state: "Offered", prompt: `Review https://github.com/acme/app/pull/7 at ${"c".repeat(40)}` },
    );
    const [freed, side] = [...sides].find(([id]) => id !== queued.hostId) ?? assert.fail("no second host");
    assert.equal(side.holds("TurnOffer"), false);
    side.report({ ...USAGE, memoryBudgetMib: box, memoryHeldMib: 0 });
    const offer = await side.next("TurnOffer");
    assert.deepEqual(
      { sessionId: offer.sessionId, turnId: offer.turnId },
      {
        sessionId: queued.sessionId,
        turnId: queued.lastTurn.turnId,
      },
    );
    assert.equal((await getJson(`/v1/sessions/${queued.sessionId}`, SessionSchema)).hostId, freed);
    side.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await side.next("TurnClaimed")).turnId, offer.turnId);
    for (const each of sides.values()) each.close();
  });

  test("a host reporting a memory budget takes boxes past its box slots until their memory fills it, counting boxes offered since its last report", async () => {
    const { bearer, host, hostId, refused, getJson, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const budgeted = await enrol("budgeted");
    const box = BoxMemoryLimit.DefaultMib;
    const budget = 2 * box + 1024;
    const side = await connect(budgeted.id, budgeted.key, 1, undefined, undefined, {
      ...USAGE,
      memoryBudgetMib: budget,
      memoryHeldMib: 0,
    });
    await hostState(budgeted.id, "Online");
    side.quiet();
    const start = async (prompt: string) =>
      postJson("/v1/sessions", { ...(await sessionStart()), prompt }, bearer).then(async (response) => {
        assert.equal(response.status, 200, await response.clone().text());
        return StartedSessionSchema.parse(await response.json()).session.hostId;
      });
    assert.deepEqual([await start("first"), await start("second")], [budgeted.id, budgeted.id]);
    const full = await refused("/v1/sessions", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(await sessionStart()), prompt: "third" }),
    });
    assert.deepEqual(
      [full.code, full.detail],
      [
        "PoolExhausted",
        `no host of your tenant has memory for another box: box is Offline, budgeted gives boxes ${budget} MiB of memory and its boxes hold ${2 * box} MiB of it, and the persona's boxes need ${box} MiB`,
      ],
    );
    side.report({ ...USAGE, memoryBudgetMib: budget, memoryHeldMib: box });
    await until(
      "the host's report of one held box",
      () => getJson("/v1/hosts/usage", ReportedHostUsageSchema.array()),
      (usages) => usages.find((usage) => usage.hostId === budgeted.id)?.memoryHeldMib === box,
    );
    assert.equal(await start("third"), budgeted.id);
    side.close();
  });

  const idleTurn = async (side: HostSide, args: Record<string, unknown>, bearer: Record<string, string>) => {
    const response = await postJson("/v1/sessions", args, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const started = StartedSessionSchema.parse(await response.json());
    const offer = await side.next("TurnOffer");
    assert.equal(offer.sessionId, started.session.sessionId);
    side.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    side.send({
      type: "TurnLine",
      turnId: offer.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    side.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    return { session: started.session, offer };
  };

  const releasedBox = async (side: HostSide, sessionId: string, boxId: string) => {
    const request = await side.next("SnapshotRequest");
    assert.equal(request.sessionId, sessionId);
    await storeRoot(request.storageKey);
    side.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
    const teardown = await side.next("BoxTeardown");
    assert.deepEqual(teardown, { type: "BoxTeardown", sessionId, boxId });
  };

  test("a start with no free slot evicts the least recently used idle Auto box and holds its offer until that box is gone", async () => {
    const { bearer, host, hostId, getJson, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const tight = await enrol("tight");
    const side = await connect(tight.id, tight.key, 1);
    await hostState(tight.id, "Online");
    const kept = await idleTurn(side, { ...(await sessionStart()), prompt: "keep me" }, bearer);
    assert.equal(kept.session.boxRetention, "Auto");
    const snapshot = await side.next("SnapshotRequest");
    await storeRoot(snapshot.storageKey);
    side.send({ type: "SnapshotDone", snapshotId: snapshot.snapshotId, uploadedBytes: 14 });
    await until(
      "the first session reading Idle",
      () => getJson(`/v1/sessions/${kept.session.sessionId}`, SessionSchema),
      (session) => session.state === "Idle",
    );
    const response = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "make room" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const next = StartedSessionSchema.parse(await response.json());
    assert.equal(next.session.hostId, tight.id);
    assert.deepEqual(await side.next("BoxTeardown"), {
      type: "BoxTeardown",
      sessionId: kept.session.sessionId,
      boxId: kept.offer.boxId,
    });
    assert.equal(side.holds("TurnOffer"), false, "the new turn's offer waits for the evicted box's BoxGone");
    assert.equal((await getJson(`/v1/turns/${next.turn.turnId}`, TurnSchema)).state, "Offered");
    side.send({ type: "BoxGone", sessionId: kept.session.sessionId, boxId: kept.offer.boxId });
    assert.equal((await side.next("TurnOffer")).turnId, next.turn.turnId);
    assert.equal((await getJson(`/v1/sessions/${kept.session.sessionId}`, SessionSchema)).state, "Stopped");
    side.close();
  });

  test("an Auto box idle for 15 minutes with its snapshot stored is torn down, and the next turn restores it on a fresh box", async () => {
    const { bearer, host, getJson, sessionStart } = await tenant();
    const idle = await idleTurn(host, { ...(await sessionStart()), prompt: "go quiet" }, bearer);
    const { sessionId, tenantId } = idle.session;
    const snapshot = await host.next("SnapshotRequest");
    await storeRoot(snapshot.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: snapshot.snapshotId, uploadedBytes: 14 });
    const timers = await until(
      "the idle teardown armed",
      () => storedTimers(sessionId),
      (stored) => stored?.deadlines.Teardown !== undefined,
    );
    const armed = z.object({ turnId: z.string(), at: z.number() }).parse(timers?.deadlines.Teardown);
    assert.equal(armed.turnId, idle.offer.turnId);
    assert.ok(armed.at > Date.now() + 14 * 60 * 1000, `the eviction is due at ${armed.at}, before 15 idle minutes`);
    assert.equal(host.holds("BoxTeardown"), false);

    const at = Date.now();
    await storeTimers(sessionId, { tenantId, sessionId, deadlines: { Teardown: { turnId: armed.turnId, at } } }, at);
    assert.deepEqual(await host.next("BoxTeardown"), { type: "BoxTeardown", sessionId, boxId: idle.offer.boxId });
    host.send({ type: "BoxGone", sessionId, boxId: idle.offer.boxId });
    const evicted = await until(
      "the evicted session settling",
      () => getJson(`/v1/sessions/${sessionId}`, SessionSchema),
      (session) => session.state !== "Stopping",
    );
    assert.notEqual(evicted.state, "Failed");

    const sent = await postJson(`/v1/sessions/${sessionId}/turns`, { prompt: "wake up" }, bearer);
    assert.equal(sent.status, 200, await sent.clone().text());
    const offer = await host.next("TurnOffer");
    assert.equal(offer.sessionId, sessionId);
    assert.notEqual(offer.boxId, idle.offer.boxId);
    assert.deepEqual(
      offer.snapshots.map((each) => each.snapshotId),
      [snapshot.snapshotId],
    );
  });

  test("an Auto box whose latest turn was cancelled while it waited is snapshotted again and torn down after 15 idle minutes", async () => {
    const { host, tool, sessionStart } = await tenant();
    const started = await tool(
      "tumpel_session_start",
      { ...(await sessionStart()), prompt: "busy" },
      StartedSessionSchema,
    );
    const { sessionId, tenantId } = started.session;
    const first = await host.next("TurnOffer");
    host.send({ type: "TurnClaim", turnId: first.turnId, boxId: first.boxId });
    await until(
      "the turn reading Running",
      () => tool("tumpel_turn_get", { turnId: first.turnId }, TurnSchema),
      (turn) => turn.state === "Running",
    );
    const waiting = await tool("tumpel_turn_send", { sessionId, prompt: "never mind" }, TurnSchema);
    const cancelled = await tool("tumpel_turn_cancel", { turnId: waiting.turnId }, TurnSchema);
    assert.equal(cancelled.state, "Failed");

    host.send({
      type: "TurnLine",
      turnId: first.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    host.send({ type: "TurnComplete", turnId: first.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    const completed = await host.next("SnapshotRequest");
    assert.equal(completed.turnId, first.turnId);
    await storeRoot(completed.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: completed.snapshotId, uploadedBytes: 14 });

    const after = await host.next("SnapshotRequest");
    assert.deepEqual([after.turnId, after.boxId], [waiting.turnId, first.boxId]);
    await storeRoot(after.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: after.snapshotId, uploadedBytes: 14 });
    const timers = await until(
      "the idle teardown armed",
      () => storedTimers(sessionId),
      (stored) => stored?.deadlines.Teardown !== undefined,
    );
    const armed = z.object({ turnId: z.string(), at: z.number() }).parse(timers?.deadlines.Teardown);
    assert.equal(armed.turnId, waiting.turnId);
    assert.ok(armed.at > Date.now() + 14 * 60 * 1000, `the eviction is due at ${armed.at}, before 15 idle minutes`);
    assert.equal(host.holds("BoxTeardown"), false);

    const at = Date.now();
    await storeTimers(sessionId, { tenantId, sessionId, deadlines: { Teardown: { turnId: armed.turnId, at } } }, at);
    assert.deepEqual(await host.next("BoxTeardown"), { type: "BoxTeardown", sessionId, boxId: first.boxId });
  });

  test("a delivery to an evicted session waits while every box runs or releases, and another host places it once it has room", async () => {
    const { bearer, host, hostId, getJson, tool, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const tight = await enrol("tight");
    const side = await connect(tight.id, tight.key, 2);
    await hostState(tight.id, "Online");
    side.quiet();
    const foreman = await idleTurn(side, { ...(await sessionStart()), prompt: "lead the crew" }, bearer);
    const foremanId = foreman.session.sessionId;
    const snapshot = await side.next("SnapshotRequest");
    await storeRoot(snapshot.storageKey);
    side.send({ type: "SnapshotDone", snapshotId: snapshot.snapshotId, uploadedBytes: 14 });
    await until(
      "the foreman reading Idle",
      () => getJson(`/v1/sessions/${foremanId}`, SessionSchema),
      (session) => session.state === "Idle",
    );
    const subscription = await tool(
      "tumpel_subscription_create",
      {
        sessionId: foremanId,
        prompt: "review what the crew did",
        goal: "every crew turn is reviewed",
        events: ["TurnCompleted"],
        crewTags: ["crew:review"],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      SubscriptionSchema,
    );

    const crewStart = await postJson(
      "/v1/sessions",
      { ...(await sessionStart()), prompt: "review a pull request", tags: ["crew:review"], boxRetention: "Off" },
      bearer,
    );
    assert.equal(crewStart.status, 200, await crewStart.clone().text());
    const crew = StartedSessionSchema.parse(await crewStart.json());
    const crewOffer = await side.next("TurnOffer");
    assert.equal(crewOffer.turnId, crew.turn.turnId);
    side.send({ type: "TurnClaim", turnId: crewOffer.turnId, boxId: crewOffer.boxId });

    const busyStart = await postJson("/v1/sessions", { ...(await sessionStart()), prompt: "keep running" }, bearer);
    assert.equal(busyStart.status, 200, await busyStart.clone().text());
    const busy = StartedSessionSchema.parse(await busyStart.json());
    assert.deepEqual(await side.next("BoxTeardown"), {
      type: "BoxTeardown",
      sessionId: foremanId,
      boxId: foreman.offer.boxId,
    });
    side.send({ type: "BoxGone", sessionId: foremanId, boxId: foreman.offer.boxId });
    const busyOffer = await side.next("TurnOffer");
    assert.equal(busyOffer.turnId, busy.turn.turnId);
    side.send({ type: "TurnClaim", turnId: busyOffer.turnId, boxId: busyOffer.boxId });

    side.send({
      type: "TurnLine",
      turnId: crewOffer.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    side.send({
      type: "TurnComplete",
      turnId: crewOffer.turnId,
      lastLineSeq: 1,
      completedAt: new Date().toISOString(),
    });
    const crewSnapshot = await side.next("SnapshotRequest");
    await storeRoot(crewSnapshot.storageKey);
    side.send({ type: "SnapshotDone", snapshotId: crewSnapshot.snapshotId, uploadedBytes: 14 });
    assert.deepEqual(await side.next("BoxTeardown"), {
      type: "BoxTeardown",
      sessionId: crew.session.sessionId,
      boxId: crewOffer.boxId,
    });
    const [, delivery] = await until(
      "the foreman's delivery turn",
      () => getJson(`/v1/sessions/${foremanId}/turns`, TurnSchema.array()),
      (turns) => turns.length === 2,
    );
    assert.equal(delivery?.state, "Offered");
    const waiting = await tool(
      "tumpel_subscription_get",
      { subscriptionId: subscription.subscriptionId },
      SubscriptionSchema,
    );
    assert.deepEqual([waiting.state, waiting.deliveryFailuresInARow], ["Active", 0]);
    assert.equal(side.holds("TurnOffer"), false, "the delivery waits while both boxes are taken");

    const roomy = await enrol("roomy");
    const other = await connect(roomy.id, roomy.key, 1);
    await hostState(roomy.id, "Online");
    other.quiet();
    other.report(USAGE);
    const offer = await other.next("TurnOffer");
    assert.equal(offer.turnId, delivery?.turnId);
    assert.notEqual(offer.boxId, foreman.offer.boxId);
    assert.deepEqual(
      offer.snapshots.map((each) => each.snapshotId),
      [snapshot.snapshotId],
    );
    assert.equal(side.holds("TurnOffer"), false, "the full host never gets the delivery");
    other.close();
    side.close();
  });

  test("an Off session releases its box after each turn and its next turn boots a fresh box on the same host", async () => {
    const { bearer, host, getJson, sessionStart } = await tenant();
    const off = await idleTurn(host, { ...(await sessionStart()), prompt: "once", boxRetention: "Off" }, bearer);
    const { sessionId } = off.session;
    assert.equal(off.session.boxRetention, "Off");
    await releasedBox(host, sessionId, off.offer.boxId);
    assert.equal((await getJson(`/v1/sessions/${sessionId}`, SessionSchema)).state, "Stopping");
    host.send({ type: "BoxGone", sessionId, boxId: off.offer.boxId });
    await until(
      "the Off session reading Stopped",
      () => getJson(`/v1/sessions/${sessionId}`, SessionSchema),
      (session) => session.state === "Stopped",
    );
    const sent = await postJson(`/v1/sessions/${sessionId}/turns`, { prompt: "again" }, bearer);
    assert.equal(sent.status, 200, await sent.clone().text());
    const offer = await host.next("TurnOffer");
    assert.equal(offer.sessionId, sessionId);
    assert.notEqual(offer.boxId, off.offer.boxId);
  });

  test("a send during an Off release waits for the box to go and runs on a fresh box, while a person's stop refuses sends", async () => {
    const { bearer, host, getJson, refused, tool, sessionStart } = await tenant();
    const off = await idleTurn(host, { ...(await sessionStart()), prompt: "once", boxRetention: "Off" }, bearer);
    const { sessionId } = off.session;
    const request = await host.next("SnapshotRequest");
    await storeRoot(request.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
    const teardown = await host.next("BoxTeardown");
    const sent = await postJson(`/v1/sessions/${sessionId}/turns`, { prompt: "while releasing" }, bearer);
    assert.equal(sent.status, 200, await sent.clone().text());
    const queued = TurnSchema.parse(await sent.json());
    assert.equal(queued.state, "Offered");
    assert.equal(host.holds("TurnOffer"), false, "the queued turn waits for the released box's BoxGone");
    host.send({ type: "BoxGone", sessionId, boxId: teardown.boxId });
    const offer = await host.next("TurnOffer");
    assert.deepEqual([offer.turnId, offer.sessionId], [queued.turnId, sessionId]);
    assert.notEqual(offer.boxId, off.offer.boxId);

    const kept = await idleTurn(host, { ...(await sessionStart()), prompt: "keep" }, bearer);
    const keptSnapshot = await host.next("SnapshotRequest");
    await storeRoot(keptSnapshot.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: keptSnapshot.snapshotId, uploadedBytes: 14 });
    await until(
      "the kept session reading Idle",
      () => getJson(`/v1/sessions/${kept.session.sessionId}`, SessionSchema),
      (session) => session.state === "Idle",
    );
    assert.equal(
      (await tool("tumpel_session_stop", { sessionId: kept.session.sessionId }, SessionSchema)).state,
      "Stopping",
    );
    const stopping = await refused(`/v1/sessions/${kept.session.sessionId}/turns`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "too late" }),
    });
    assert.equal(stopping.code, "SessionStopping");
  });

  test("the first heartbeat after a reconnect releases the boxes a host still holds for Stopped, archived and idle Off sessions, and keeps Warm, Auto and running boxes", async () => {
    const { bearer, host, hostId, getJson, tool, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
    const drift = await enrol("drift");
    const first = await connect(drift.id, drift.key);
    await hostState(drift.id, "Online");
    first.report({ ...USAGE, loadAverage: 0.5 });
    await until(
      "the first heartbeat of the first connection",
      () => getJson("/v1/hosts/usage", ReportedHostUsageSchema.array()),
      (usages) => usages.find((usage) => usage.hostId === drift.id)?.loadAverage === 0.5,
    );
    const snapshotted = async (sessionId: string) => {
      const request = await first.next("SnapshotRequest");
      assert.equal(request.sessionId, sessionId);
      await storeRoot(request.storageKey);
      first.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 14 });
      await until(
        `session ${sessionId} reading Idle with snapshot ${request.snapshotId}`,
        async () => ({
          session: await getJson(`/v1/sessions/${sessionId}`, SessionSchema),
          snapshots: await tool("tumpel_snapshot_list", { sessionId }, SnapshotSchema.array()),
        }),
        ({ session, snapshots }) =>
          session.state === "Idle" && snapshots.some((snapshot) => snapshot.snapshotId === request.snapshotId),
      );
    };

    const stopped = await idleTurn(
      first,
      { ...(await sessionStart()), prompt: "stopped", boxRetention: "Off" },
      bearer,
    );
    await releasedBox(first, stopped.session.sessionId, stopped.offer.boxId);
    first.send({ type: "BoxGone", sessionId: stopped.session.sessionId, boxId: stopped.offer.boxId });
    await until(
      "the stopped session reading Stopped",
      () => getJson(`/v1/sessions/${stopped.session.sessionId}`, SessionSchema),
      (session) => session.state === "Stopped",
    );

    const off = await idleTurn(first, { ...(await sessionStart()), prompt: "off", boxRetention: "Off" }, bearer);
    await releasedBox(first, off.session.sessionId, off.offer.boxId);
    first.send({
      type: "BoxTeardownFailed",
      sessionId: off.session.sessionId,
      boxId: off.offer.boxId,
      reason: "BoxDirty",
      detail: "the box is busy",
      failedAt: new Date().toISOString(),
    });
    await snapshotted(off.session.sessionId);

    const archived = await idleTurn(first, { ...(await sessionStart()), prompt: "archived" }, bearer);
    await snapshotted(archived.session.sessionId);
    assert.equal(
      (await tool("tumpel_session_archive", { sessionId: archived.session.sessionId }, SessionSchema)).state,
      "Archived",
    );
    assert.equal((await first.next("BoxDiscard")).sessionId, archived.session.sessionId);

    const warm = await idleTurn(first, { ...(await sessionStart()), prompt: "warm", boxRetention: "Warm" }, bearer);
    await snapshotted(warm.session.sessionId);
    const auto = await idleTurn(first, { ...(await sessionStart()), prompt: "auto" }, bearer);
    await snapshotted(auto.session.sessionId);
    const running = await postJson(
      "/v1/sessions",
      { ...(await sessionStart()), prompt: "running", boxRetention: "Off" },
      bearer,
    );
    assert.equal(running.status, 200, await running.clone().text());
    const runningOffer = await first.next("TurnOffer");
    first.send({ type: "TurnClaim", turnId: runningOffer.turnId, boxId: runningOffer.boxId });
    await first.next("TurnClaimed");

    first.close();
    await hostState(drift.id, "Offline");
    const back = await connect(drift.id, drift.key, 8, first.carried());
    const released = [await back.next("BoxDiscard"), await back.next("BoxDiscard"), await back.next("BoxTeardown")];
    assert.deepEqual(
      released.map((message) => [message.type, message.sessionId, message.boxId]).sort(),
      [
        ["BoxDiscard", stopped.session.sessionId, stopped.offer.boxId],
        ["BoxDiscard", archived.session.sessionId, archived.offer.boxId],
        ["BoxTeardown", off.session.sessionId, off.offer.boxId],
      ].sort(),
    );

    const sent = await postJson(`/v1/sessions/${warm.session.sessionId}/turns`, { prompt: "still warm" }, bearer);
    assert.equal(sent.status, 200, await sent.clone().text());
    assert.equal((await back.next("TurnOffer")).boxId, warm.offer.boxId);
    assert.equal(back.holds("BoxDiscard") || back.holds("BoxTeardown"), false);
    assert.equal((await getJson(`/v1/sessions/${auto.session.sessionId}`, SessionSchema)).state, "Idle");
    assert.equal((await getJson(`/v1/turns/${runningOffer.turnId}`, TurnSchema)).state, "Running");
    back.close();
  });

  const sealedValues = async (tenantId: string) =>
    z
      .object({ secret_set_id: z.string(), name: z.string(), sealed: z.string() })
      .array()
      .parse(await tenantSql(tenantId, "SELECT secret_set_id, name, sealed FROM secret_values"));

  const writeSealed = async (
    tenantId: string,
    rows: { secret_set_id: string; name: string; sealed: string }[],
    corrupt: boolean,
  ): Promise<void> => {
    for (const row of rows) {
      await tenantSql(
        tenantId,
        "UPDATE secret_values SET sealed = ? WHERE secret_set_id = ? AND name = ?",
        corrupt ? `${row.sealed.slice(0, -4)}AAAA` : row.sealed,
        row.secret_set_id,
        row.name,
      );
    }
  };

  test("a turn whose offer fails after the turn is stored is offered on the host's next heartbeat and runs", async () => {
    const { tenantId, bearer, host, getJson, completedTurn, storedSnapshot } = await tenant();
    const { session, offer: first } = await completedTurn("first");
    await storedSnapshot(session.sessionId);
    assert.equal((await host.next("TurnClaimed")).turnId, first.turnId);
    await until(
      "the first turn reading Completed",
      () => getJson(`/v1/turns/${first.turnId}`, TurnSchema),
      (turn) => turn.state === "Completed",
    );
    const sealed = await sealedValues(tenantId);
    assert.notEqual(sealed.length, 0);
    await writeSealed(tenantId, sealed, true);
    const sent = await postJson(
      `/v1/sessions/${session.sessionId}/turns`,
      { prompt: "sent while undecryptable" },
      bearer,
    );
    assert.equal(sent.status, 200, await sent.clone().text());
    const queued = TurnSchema.parse(await sent.json());
    assert.equal(queued.state, "Offered");
    await writeSealed(tenantId, sealed, false);

    const offer = await host.next("TurnOffer");
    assert.equal(offer.turnId, queued.turnId);
    assert.equal(offer.prompt, "sent while undecryptable");
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await host.next("TurnClaimed")).turnId, queued.turnId);
    assert.equal((await getJson(`/v1/turns/${queued.turnId}`, TurnSchema)).state, "Running");
  });

  test("a queued turn whose persona is gone fails CredentialRefused and the next queued turn on its host is offered", async () => {
    const { tenantId, bearer, host, getJson, completedTurn, storedSnapshot } = await tenant();
    const sessions = [];
    for (const prompt of ["first", "second"]) {
      const { session, offer } = await completedTurn(prompt);
      await storedSnapshot(session.sessionId);
      assert.equal((await host.next("TurnClaimed")).turnId, offer.turnId);
      await until(
        `the ${prompt} turn reading Completed`,
        () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
        (turn) => turn.state === "Completed",
      );
      sessions.push(session.sessionId);
    }
    const [doomedSession, waitingSession] = sessions;
    assert.ok(doomedSession !== undefined && waitingSession !== undefined);
    const sealed = await sealedValues(tenantId);
    await writeSealed(tenantId, sealed, true);
    const queued = [];
    for (const sessionId of sessions) {
      const sent = await postJson(`/v1/sessions/${sessionId}/turns`, { prompt: "queued" }, bearer);
      assert.equal(sent.status, 200, await sent.clone().text());
      queued.push(TurnSchema.parse(await sent.json()));
    }
    const [doomed, waiting] = queued;
    assert.ok(doomed !== undefined && waiting !== undefined);
    const gone = crypto.randomUUID();
    await tenantSql(tenantId, "UPDATE sessions SET persona_id = ? WHERE session_id = ?", gone, doomedSession);
    await writeSealed(tenantId, sealed, false);

    const offer = await host.next("TurnOffer");
    assert.equal(offer.turnId, waiting.turnId);
    await until(
      "the doomed turn reading Failed",
      () => getJson(`/v1/turns/${doomed.turnId}`, TurnSchema),
      (turn) => turn.state === "Failed",
    );
    const failure = await getJson(`/v1/turns/${doomed.turnId}/failure`, TurnFailureSchema);
    assert.equal(failure.reason, "CredentialRefused");
    assert.equal(
      failure.detail,
      `the session runs on persona ${gone}, which is gone, so the turn has no secret set to run on; start a new session on an existing persona`,
    );
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await host.next("TurnClaimed")).turnId, waiting.turnId);
  });

  test("a repeated claim of a completed turn is withdrawn and a NotClaimed failure after it leaves the turn Completed", async () => {
    const { host, getJson, completedTurn, storedSnapshot } = await tenant();
    const { session, offer } = await completedTurn("ran once");
    await storedSnapshot(session.sessionId);
    assert.equal((await host.next("TurnClaimed")).turnId, offer.turnId);
    await until(
      "the turn reading Completed",
      () => getJson(`/v1/turns/${offer.turnId}`, TurnSchema),
      (turn) => turn.state === "Completed",
    );
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.deepEqual(await host.next("TurnWithdrawn"), { type: "TurnWithdrawn", turnId: offer.turnId });
    host.send({
      type: "TurnFailed",
      turnId: offer.turnId,
      reason: "NotClaimed",
      detail: "this supervisor stopped waiting for the answer to the claim",
      failedAt: new Date().toISOString(),
    });
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.deepEqual(await host.next("TurnWithdrawn"), { type: "TurnWithdrawn", turnId: offer.turnId });
    assert.equal((await getJson(`/v1/turns/${offer.turnId}`, TurnSchema)).state, "Completed");
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
    restarting.send({
      type: "TurnLine",
      turnId: first.turnId,
      lineSeq: 1,
      text: '{"type":"result","subtype":"success","is_error":false}',
    });
    restarting.send({
      type: "TurnComplete",
      turnId: first.turnId,
      lastLineSeq: 1,
      completedAt: new Date().toISOString(),
    });
    const firstSnapshot = await restarting.next("SnapshotRequest");
    await storeRoot(firstSnapshot.storageKey);
    restarting.send({ type: "SnapshotDone", snapshotId: firstSnapshot.snapshotId, uploadedBytes: 14 });
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
    const restarted = await connect(only.id, only.key, 32, restarting.carried());
    const offer = await restarted.next("TurnOffer");
    assert.equal(offer.turnId, turn.turnId);
    restarted.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    assert.equal((await restarted.next("TurnClaimed")).turnId, turn.turnId);
    restarted.close();
  });

  test("two hosts refusing their turns HostUpdating at the same moment each hand the turn to the other", async () => {
    const { bearer, host, hostId, getJson, enrol, sessionStart, hostState } = await tenant();
    host.close();
    await hostState(hostId, "Offline");
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
  const building = await getJson(`/v1/sessions/${offer.sessionId}`, SessionSchema);
  assert.deepEqual(building.prebuildLayer, {
    layer: "None",
    reason: "BuildsPrebuild",
    detail: `the session builds a prebuild of ${repository}, so its box starts from the guest image alone`,
  });
  assert.deepEqual(installationTokenRequests.at(-1), { repositories: ["app"], permissions: { contents: "read" } });
  assert.equal(new URL(started.logUrl).pathname, `/v1/sessions/${offer.sessionId}/transcript`);

  host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
  await host.next("TurnClaimed");
  const read = () => getJson(`/v1/prebuilds/${started.prebuildId}`, PrebuildSchema);
  await until("the prebuild reading Building", read, (prebuild) => prebuild.status.state === "Building");
  host.send({ type: "TurnRepositoryReady", turnId: offer.turnId });
  host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: "prebuild: running onCreateCommand" });
  host.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  const request = await host.next("SnapshotRequest");
  assert.equal(request.sessionId, offer.sessionId);
  const prebuiltRoot = await storeRoot(request.storageKey);
  host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 4096 });
  const teardown = await host.next("BoxTeardown");
  host.send({ type: "BoxGone", sessionId: teardown.sessionId, boxId: teardown.boxId });
  const done = await until("the prebuild reading Done", read, (prebuild) => prebuild.status.state === "Done");
  if (done.status.state !== "Done") throw new Error(`prebuild ${started.prebuildId} is ${done.status.state}`);
  assert.deepEqual(
    { layerDigest: done.status.layerDigest, layerSizeBytes: done.status.layerSizeBytes },
    { layerDigest: createHash("sha256").update(prebuiltRoot).digest("hex"), layerSizeBytes: 4096 },
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
  const prebuilt = { layer: "Prebuild", prebuildId: started.prebuildId, layerDigest: done.status.layerDigest };
  assert.deepEqual((await getJson(`/v1/sessions/${consumer.sessionId}`, SessionSchema)).prebuildLayer, prebuilt);
  assert.ok(consumer.image.kind === "Layered");
  assert.equal(started.guestImageDigest, consumer.image.base.imageDigest);
  assert.deepEqual((await getJson(`/v1/turns/${consumer.turnId}`, TurnSchema)).image, {
    kind: "Layered",
    baseImageDigest: consumer.image.base.imageDigest,
    harnessLayerDigest: consumer.image.layer.layer.layerDigest,
  });

  host.send({ type: "TurnClaim", turnId: consumer.turnId, boxId: consumer.boxId });
  await host.next("TurnClaimed");
  host.send({ type: "TurnLine", turnId: consumer.turnId, lineSeq: 1, text: "{}" });
  host.send({ type: "TurnComplete", turnId: consumer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  const own = await host.next("SnapshotRequest");
  assert.equal(own.sessionId, consumer.sessionId);
  await storeRoot(own.storageKey);
  host.send({ type: "SnapshotDone", snapshotId: own.snapshotId, uploadedBytes: 14 });
  await until(
    "the consumer's own snapshot stored",
    () => getJson(`/v1/sessions/${consumer.sessionId}/snapshots`, SnapshotSchema.array()),
    (snapshots) => snapshots.length === 1,
  );
  const sent = await postJson(`/v1/sessions/${consumer.sessionId}/turns`, { prompt: "after my snapshot" }, bearer);
  assert.equal(sent.status, 200, await sent.clone().text());
  const restoring = await host.next("TurnOffer");
  assert.deepEqual(
    restoring.snapshots.map((snapshot) => snapshot.snapshotId),
    [own.snapshotId],
  );
  assert.deepEqual((await getJson(`/v1/sessions/${consumer.sessionId}`, SessionSchema)).prebuildLayer, prebuilt);
});

test("a newer prebuild archives the older one only once no session still restores from it", async () => {
  const { tenantId, bearer, host, getJson, sessionStart } = await tenant();
  await installPrebuiltApp(tenantId);
  const { personaId } = await sessionStart();
  const repository = "https://github.com/prebuilt/app";
  const prebuild = async () => {
    const response = await postJson("/v1/prebuilds", { repository, personaId, provider: "CircleCI" }, bearer);
    assert.equal(response.status, 200, await response.clone().text());
    const started = PrebuildSchema.parse(await response.json());
    const offer = await host.next("TurnOffer");
    assert.equal(offer.prebuildCommitSha, PREBUILT_HEAD);
    host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
    await host.next("TurnClaimed");
    host.send({ type: "TurnRepositoryReady", turnId: offer.turnId });
    host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: "prebuild: running onCreateCommand" });
    host.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
    const request = await host.next("SnapshotRequest");
    await storeRoot(request.storageKey);
    host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 4096 });
    const teardown = await host.next("BoxTeardown");
    host.send({ type: "BoxGone", sessionId: teardown.sessionId, boxId: teardown.boxId });
    await until(
      "the prebuild reading Done",
      () => getJson(`/v1/prebuilds/${started.prebuildId}`, PrebuildSchema),
      (read) => read.status.state === "Done",
    );
    return { prebuildId: started.prebuildId, request };
  };
  const older = await prebuild();
  await tenantSql(tenantId, "UPDATE prebuilds SET input_digest = ? WHERE prebuild_id = ?", "older", older.prebuildId);

  const next = await postJson(
    "/v1/sessions",
    { ...(await sessionStart()), repository, prompt: "restore the older" },
    bearer,
  );
  assert.equal(next.status, 200, await next.clone().text());
  const consumer = await host.next("TurnOffer");
  assert.deepEqual(
    consumer.snapshots.map((snapshot) => snapshot.snapshotId),
    [older.request.snapshotId],
  );
  const newer = await prebuild();
  assert.notEqual(await store.text(older.request.storageKey), null);

  host.send({ type: "TurnClaim", turnId: consumer.turnId, boxId: consumer.boxId });
  await host.next("TurnClaimed");
  host.send({ type: "TurnLine", turnId: consumer.turnId, lineSeq: 1, text: "{}" });
  host.send({ type: "TurnComplete", turnId: consumer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  const own = await host.next("SnapshotRequest");
  await storeRoot(own.storageKey);
  host.send({ type: "SnapshotDone", snapshotId: own.snapshotId, uploadedBytes: 14 });
  await until(
    "the older prebuild's root deleted",
    () => store.text(older.request.storageKey),
    (text) => text === null,
  );
  assert.notEqual(await store.text(newer.request.storageKey), null);
});

test("archiving the current prebuild by hand keeps its root until the session restoring from it stores its own snapshot", async () => {
  const { tenantId, bearer, host, getJson, sessionStart } = await tenant();
  await installPrebuiltApp(tenantId);
  const { personaId } = await sessionStart();
  const repository = "https://github.com/prebuilt/app";
  const response = await postJson("/v1/prebuilds", { repository, personaId, provider: "CircleCI" }, bearer);
  assert.equal(response.status, 200, await response.clone().text());
  const started = PrebuildSchema.parse(await response.json());
  const offer = await host.next("TurnOffer");
  host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
  await host.next("TurnClaimed");
  host.send({ type: "TurnRepositoryReady", turnId: offer.turnId });
  host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: "prebuild: running onCreateCommand" });
  host.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  const request = await host.next("SnapshotRequest");
  await storeRoot(request.storageKey);
  host.send({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: 4096 });
  const teardown = await host.next("BoxTeardown");
  host.send({ type: "BoxGone", sessionId: teardown.sessionId, boxId: teardown.boxId });
  await until(
    "the prebuild reading Done",
    () => getJson(`/v1/prebuilds/${started.prebuildId}`, PrebuildSchema),
    (read) => read.status.state === "Done",
  );

  const next = await postJson("/v1/sessions", { ...(await sessionStart()), repository, prompt: "restore it" }, bearer);
  assert.equal(next.status, 200, await next.clone().text());
  const consumer = await host.next("TurnOffer");
  assert.deepEqual(
    consumer.snapshots.map((snapshot) => snapshot.snapshotId),
    [request.snapshotId],
  );
  const archived = await postJson(`/v1/sessions/${offer.sessionId}/archive`, {}, bearer);
  assert.equal(archived.status, 200, await archived.clone().text());
  assert.equal(SessionSchema.parse(await archived.json()).state, "Archived");
  assert.notEqual(await store.text(request.storageKey), null);

  host.send({ type: "TurnClaim", turnId: consumer.turnId, boxId: consumer.boxId });
  await host.next("TurnClaimed");
  host.send({ type: "TurnLine", turnId: consumer.turnId, lineSeq: 1, text: "{}" });
  host.send({ type: "TurnComplete", turnId: consumer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  const own = await host.next("SnapshotRequest");
  await storeRoot(own.storageKey);
  host.send({ type: "SnapshotDone", snapshotId: own.snapshotId, uploadedBytes: 14 });
  await until(
    "the archived prebuild's root deleted",
    () => store.text(request.storageKey),
    (text) => text === null,
  );
});

test("a prebuild whose snapshot fails reads Failed and its box is discarded over the channel the failure came in on", async () => {
  const { tenantId, bearer, host, getJson, sessionStart } = await tenant();
  await installPrebuiltApp(tenantId);
  const { personaId } = await sessionStart();
  const response = await postJson(
    "/v1/prebuilds",
    { repository: "https://github.com/prebuilt/app", personaId, provider: "CircleCI" },
    bearer,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const started = PrebuildSchema.parse(await response.json());
  const offer = await host.next("TurnOffer");
  host.send({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
  await host.next("TurnClaimed");
  host.send({ type: "TurnRepositoryReady", turnId: offer.turnId });
  host.send({ type: "TurnLine", turnId: offer.turnId, lineSeq: 1, text: "prebuild: running onCreateCommand" });
  host.send({ type: "TurnComplete", turnId: offer.turnId, lastLineSeq: 1, completedAt: new Date().toISOString() });
  const request = await host.next("SnapshotRequest");
  host.send({
    type: "SnapshotFailed",
    snapshotId: request.snapshotId,
    reason: "UploadRejected",
    detail: "the store refused the upload",
    failedAt: new Date().toISOString(),
  });

  const discard = await host.next("BoxDiscard");
  assert.deepEqual(
    { sessionId: discard.sessionId, boxId: discard.boxId },
    { sessionId: offer.sessionId, boxId: offer.boxId },
  );
  host.assertOpen("after the BoxDiscard");
  const failed = await until(
    "the prebuild reading Failed",
    () => getJson(`/v1/prebuilds/${started.prebuildId}`, PrebuildSchema),
    (prebuild) => prebuild.status.state === "Failed",
  );
  assert.equal(failed.status.state === "Failed" && failed.status.phase, "Upload");
});

test("a preview reads a supplied config's commands in run order, refuses a repository without one, and stores no prebuild", async () => {
  const { bearer, getJson, tool, sessionStart } = await tenant();
  const { personaId } = await sessionStart();
  const repository = "https://github.com/prebuilt/app";
  const own = await tool(
    "tumpel_prebuild_preview",
    { source: "RepositoryFile", repository, personaId },
    PrebuildPreviewSchema,
  );
  assert.equal(own.configSource, "RepositoryFile");
  assert.deepEqual(own.commands, [
    { lifecycle: "OnCreateCommand", label: "onCreateCommand", argv: ["/bin/sh", "-c", "npm ci"] },
  ]);
  const missing = await postJson(
    "/v1/prebuilds/preview",
    { source: "RepositoryFile", repository: "https://github.com/prebuilt/bare", personaId },
    bearer,
  );
  assert.equal(missing.status, 409, await missing.clone().text());
  const refusal = ProblemSchema.parse(await missing.json());
  assert.equal(refusal.code, "DevcontainerMissing");
  assert.match(refusal.fix, /npm, python, rust/);
  const devcontainer = `{
  // JSON with comments
  "containerEnv": { "MODE": "prebuild" },
  "postStartCommand": ["npm", "run", "dev"],
  "onCreateCommand": { "install": "npm ci", "fetch": ["cargo", "fetch"] },
}`;
  const preview = await tool(
    "tumpel_prebuild_preview",
    { source: "Supplied", repository, personaId, devcontainer },
    PrebuildPreviewSchema,
  );
  assert.equal(preview.configSource, "Supplied");
  assert.deepEqual(preview.commands, [
    { lifecycle: "OnCreateCommand", label: "onCreateCommand.install", argv: ["/bin/sh", "-c", "npm ci"] },
    { lifecycle: "OnCreateCommand", label: "onCreateCommand.fetch", argv: ["cargo", "fetch"] },
    { lifecycle: "PostStartCommand", label: "postStartCommand", argv: ["npm", "run", "dev"] },
  ]);
  assert.deepEqual(preview.containerEnv, { MODE: "prebuild" });
  assert.deepEqual(preview.findings, []);
  assert.match(preview.inputDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(await getJson(`/v1/prebuilds?repository=${repository}`, PrebuildSchema.array()), []);
});

test("templates list with their versions, an unknown one lists the valid ids, and a pull request on an owner without an installation names Connect GitHub", async () => {
  const { getJson, bearer } = await tenant();
  await storePrebuiltApp();
  const templates = await getJson("/v1/prebuild-templates", PrebuildTemplateSchema.array());
  assert.deepEqual(
    templates.map((template) => template.prebuildTemplateId),
    ["npm", "python", "rust"],
  );
  const npm = await getJson("/v1/prebuild-templates/npm/versions/1", PrebuildTemplateVersionSchema);
  assert.match(npm.devcontainer, /npm ci/);
  const unknown = await call("/v1/prebuild-templates/go/versions/1", { headers: bearer });
  assert.equal(unknown.status, 404);
  assert.match(ProblemSchema.parse(await unknown.json()).detail, /the templates are npm, python, rust/);
  const opened = await postJson(
    "/v1/prebuild-templates/pull-request",
    {
      repository: "https://github.com/elsewhere/app",
      prebuildTemplateId: "npm",
      prebuildTemplateVersion: 1,
      replace: false,
    },
    bearer,
  );
  assert.equal(opened.status, 409, await opened.clone().text());
  const refusal = ProblemSchema.parse(await opened.json());
  assert.equal(refusal.code, "GitHubNotConnected");
  assert.match(refusal.fix, /^Connect GitHub for elsewhere/);
});

test("a start on a repository without a devcontainer.json refuses and stores no prebuild", async () => {
  const { bearer, getJson, sessionStart } = await tenant();
  const { personaId } = await sessionStart();
  const repository = "https://github.com/prebuilt/bare";
  const response = await postJson("/v1/prebuilds", { repository, personaId, provider: "CircleCI" }, bearer);
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(ProblemSchema.parse(await response.json()).code, "DevcontainerMissing");
  assert.deepEqual(await getJson(`/v1/prebuilds?repository=${repository}`, PrebuildSchema.array()), []);
});
