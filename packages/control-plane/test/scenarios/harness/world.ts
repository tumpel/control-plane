import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { register } from "node:module";
import { mock } from "node:test";
import {
  DeviceAuthorizationSchema,
  DeviceTokenSchema,
  HostRecordSchema,
  MintedEnrolmentTokenSchema,
  SessionSchema,
  StartedSessionSchema,
  SubscriptionSchema,
  type TenantLimitsProfileSchema,
  TenantUsageSchema,
  TurnSchema,
  WhoamiSchema,
} from "@tumpel/schemas";
import { Agent, setGlobalDispatcher } from "undici";
import { z } from "zod";
import { CLAUDE_CODE_VERSION } from "../../../src/harness-catalog.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "../../release-fixture.ts";
import { TEST_SETTINGS } from "../../timing.ts";
import { ACCESS_AUDIENCE, AccessStub } from "./access.ts";
import { GitHubStub, installApp } from "./github.ts";
import {
  D1Database,
  flight,
  ioClock,
  migratedDatabase,
  type Namespace,
  R2Bucket,
  RateLimiter,
  Runtime,
  type SqlStorage,
  type Storage,
} from "./runtime.ts";
import { type RequestInit, request, ScenarioServer, settle } from "./server.ts";
import { hostKey, Supervisor, type SupervisorOptions, until } from "./supervisor.ts";

export type { TurnOffer } from "./supervisor.ts";

register("./hooks.mjs", import.meta.url);

const SOURCE = new URL("../../../src/", import.meta.url);
const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

type DurableObjectClass = new (ctx: never, env: never) => object;
type TenantApi = { call(operation: string, input: unknown): Promise<unknown> };
type HostRecord = { hostId: string };
type Worker = { fetch(request: Request, env: unknown): Promise<Response> };
type Tier = "Free" | "Configured";
type Limit = { measure: string; window: string; limit: number };
export type ScenarioLimits = {
  defaultTier: Tier;
  freeTenantsPerAccount: number;
  configured: Limit[];
  readsPerMinute: number;
  writesPerMinute: number;
  hostFramesPerMinute: number;
  ceiling: z.infer<typeof TenantLimitsProfileSchema>;
};
export type Member = { tenantId: string; token: string };

const imported = async <T>(path: string, name: string): Promise<T> => {
  const module: Record<string, unknown> = await import(new URL(path, SOURCE).href);
  return module[name] as T;
};

type Session = z.infer<typeof SessionSchema>;
type Subscription = z.infer<typeof SubscriptionSchema>;
type Turn = z.infer<typeof TurnSchema>;
export type TenantUsage = z.infer<typeof TenantUsageSchema>;

const START = Date.parse("2026-11-21T11:00:00Z");
export const TENANT_ID = "tenant-scenario";
export const PRINCIPAL_ID = "principal-scenario";

export type WorldOptions = {
  webhookSenders: "Running" | "Unreachable";
  vapidKey: "Valid" | "Unreadable";
  vars: Record<string, unknown>;
};
type Settings = typeof TEST_SETTINGS;
const STEP_MS = 50;

const VAPID = generateKeyPairSync("ec", { namedCurve: "P-256" });
const VAPID_JWK = VAPID.privateKey.export({ format: "jwk" });
const VAPID_PUBLIC_KEY = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(VAPID_JWK.x ?? "", "base64url"),
  Buffer.from(VAPID_JWK.y ?? "", "base64url"),
]).toString("base64url");

type TenantOperations = Record<string, (input: never) => unknown>;
const REPOSITORY = "https://github.com/acme/app";

export const SETTINGS = TEST_SETTINGS;
export const BUDGETS = { memoryBudgetMib: 30000, memoryHeldMib: 0, diskBudgetMib: 1_000_000, diskHeldMib: 0 };

export const LIMITS: ScenarioLimits = {
  defaultTier: "Configured",
  freeTenantsPerAccount: 1,
  configured: [{ measure: "RowsWritten", window: "Hour", limit: 1_000_000 }],
  readsPerMinute: 600,
  writesPerMinute: 120,
  hostFramesPerMinute: 600,
  ceiling: {
    writesPerMinute: 120,
    hostFramesPerMinute: 600,
    usage: [{ measure: "RowsWritten", window: "Hour", limit: 1_000_000 }],
  },
};

export const UNMETERED: ScenarioLimits = {
  ...LIMITS,
  hostFramesPerMinute: 1_000_000,
  ceiling: { ...LIMITS.ceiling, hostFramesPerMinute: 1_000_000 },
};

export type Host = Supervisor;

type TenantSteps = {
  expireSubscriptions(now: number): void;
};

export class World {
  readonly store = new R2Bucket();
  readonly releases = new R2Bucket();
  readonly db = new D1Database(migratedDatabase(MIGRATIONS));
  private readonly hosts = new Map<string, Supervisor>();
  private readonly dispatcher = new Agent();
  readonly dataPoints: { blobs?: string[]; doubles?: number[]; indexes?: string[] }[] = [];
  private api!: TenantApi;
  private tenants!: Namespace<object>;
  private hostChannels!: Namespace<object>;
  private server!: ScenarioServer;
  github!: GitHubStub;
  access!: AccessStub;
  origin = "";
  private tenantApi!: (namespace: unknown, tenantId: string) => TenantApi;
  private worker!: Worker;
  private env: Record<string, unknown> = {};
  readonly runtime: Runtime;
  readonly limits: ScenarioLimits;
  readonly tier: Tier;
  owner!: Member;

  private constructor(runtime: Runtime, limits: ScenarioLimits, tier: Tier) {
    this.runtime = runtime;
    this.limits = limits;
    this.tier = tier;
    setGlobalDispatcher(this.dispatcher);
  }

  static async open(
    options: Partial<WorldOptions> & { limits?: ScenarioLimits; tier?: Tier; start?: number } = {},
  ): Promise<World> {
    const { limits, tier, start, ...rest } = options;
    const world = new World(new Runtime(start ?? START), limits ?? LIMITS, tier ?? "Configured");
    await world
      .boot({ webhookSenders: "Running", vapidKey: "Valid", vars: {}, ...rest })
      .catch(async (error: unknown) => {
        await world.close();
        throw error;
      });
    return world;
  }

  get settings(): Settings {
    return this.env.TUMPEL_SETTINGS as Settings;
  }

  private async boot(options: WorldOptions): Promise<void> {
    const Tenant = await imported<DurableObjectClass>("tenant.ts", "Tenant");
    const HostChannel = await imported<DurableObjectClass>("host-channel.ts", "HostChannel");
    const EventChannel = await imported<DurableObjectClass>("event-channel.ts", "EventChannel");
    const TenantMetrics = await imported<DurableObjectClass>("tenant-metrics.ts", "TenantMetrics");
    const WebhookSender = await imported<DurableObjectClass>("webhook-sender.ts", "WebhookSender");
    const unreachable = () =>
      this.runtime.stubs(() => ({
        wake: () => Promise.reject(new Error("the webhook sender Durable Object is unreachable")),
      }));
    this.tenantApi = await imported<(namespace: unknown, tenantId: string) => TenantApi>("tenant-api.ts", "tenantApi");
    this.worker = await imported<Worker>("index.ts", "default");
    this.github = await GitHubStub.listen();
    this.access = await AccessStub.listen();
    const env: Record<string, unknown> = {
      DB: this.db,
      STORE: this.store,
      RELEASES: this.releases,
      HOST: this.runtime.namespace(HostChannel, () => env),
      EVENTS: this.runtime.namespace(EventChannel, () => env),
      WEBHOOKS:
        options.webhookSenders === "Running" ? this.runtime.namespace(WebhookSender, () => env, true) : unreachable(),
      TENANT_METRICS: this.runtime.namespace(TenantMetrics, () => env),
      METRICS: { writeDataPoint: (point: World["dataPoints"][number]) => this.dataPoints.push(point) },
      METRICS_DATASET: "tumpel_metrics_scenario",
      TUMPEL_SETTINGS: SETTINGS,
      SECRETS_KEK: Buffer.alloc(32, 7).toString("base64"),
      R2_BUCKET_NAME: "store",
      R2_ACCESS_KEY_ID: "scenario",
      R2_SECRET_ACCESS_KEY: "scenario",
      R2_ACCOUNT_ID: "scenario",
      RELEASES_BUCKET_NAME: "releases",
      RELEASES_ACCESS_KEY_ID: "scenario",
      RELEASES_SECRET_ACCESS_KEY: "scenario",
      API_ORIGIN: "https://api.scenario.test",
      GITHUB_API_ORIGIN: this.github.origin,
      ACCESS_ISSUER: this.access.issuer,
      ACCESS_AUD: ACCESS_AUDIENCE,
      VAPID_PRIVATE_KEY:
        options.vapidKey === "Valid"
          ? VAPID.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
          : "unreadable",
      VAPID_PUBLIC_KEY,
      VAPID_SUBJECT: "mailto:notifications@scenario.test",
      DASHBOARD_ORIGIN: "https://app.scenario.test",
      TUMPEL_LIMITS: this.limits,
      TENANT_READ_RATE: new RateLimiter(this.limits.readsPerMinute),
      TENANT_WRITE_RATE: new RateLimiter(this.limits.writesPerMinute),
      WEBHOOK_RATE: new RateLimiter(600),
      ...options.vars,
    };
    this.tenants = this.runtime.namespace(Tenant, () => env);
    this.hostChannels = env.HOST as Namespace<object>;
    env.TENANT = this.tenants;
    this.env = env;
    this.server = await ScenarioServer.listen((incoming) => this.worker.fetch(incoming, this.env));
    this.origin = this.server.origin;
    this.api = this.tenantApi(env.TENANT, TENANT_ID);
    await this.releases.put("current.json", JSON.stringify(CLAUDE_CODE_AMD64_RELEASE));
    this.owner = await this.member(TENANT_ID, PRINCIPAL_ID, this.tier);
    await this.call("open", { tenantId: TENANT_ID, now: Date.now() });
    await this.holdsAgentCredentials();
  }

  private async member(tenantId: string, principalId: string, tier: Tier): Promise<Member> {
    const now = Date.now();
    const token = randomBytes(32).toString("base64url");
    this.db.sql.exec(
      "INSERT INTO tenants (tenant_id, name, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      tenantId,
      tenantId,
      tier,
      now,
      now,
    );
    this.db.sql.exec(
      "INSERT INTO principals (principal_id, email, created_at, updated_at) VALUES (?, ?, ?, ?)",
      principalId,
      `${principalId}@scenario.test`,
      now,
      now,
    );
    this.db.sql.exec(
      "INSERT INTO memberships (tenant_id, principal_id, role, created_at) VALUES (?, ?, 'Owner', ?)",
      tenantId,
      principalId,
      now,
    );
    this.db.sql.exec(
      "INSERT INTO devices (device_id, token_sha256, tenant_id, principal_id, name, created_at, last_used_at) VALUES (?, ?, ?, ?, 'scenario', ?, ?)",
      randomUUID(),
      createHash("sha256").update(token).digest("hex"),
      tenantId,
      principalId,
      now,
      now,
    );
    return { tenantId, token };
  }

  async tenant(name: string, tier: Tier): Promise<Member> {
    const member = await this.member(`tenant-${name}`, `principal-${name}`, tier);
    await this.tenantApi(this.env.TENANT, member.tenantId).call("open", { tenantId: member.tenantId, now: Date.now() });
    await this.runtime.settle();
    return member;
  }

  async fetch(member: Member, method: string, path: string, body?: string): Promise<Response> {
    return this.request(path, {
      method,
      headers: { authorization: `Bearer ${member.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body }),
    });
  }

  postJson(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  browser(email: string): Record<string, string> {
    return { "cf-access-jwt-assertion": this.access.assertion(email), origin: this.origin };
  }

  async signUp(
    name: string,
    email: string,
  ): Promise<{ tenantId: string; token: string; bearer: Record<string, string> }> {
    const signedUp = await this.postJson("/v1/tenants", { name }, this.browser(email));
    if (signedUp.status !== 200) throw new Error(`signing up answered ${signedUp.status}: ${await signedUp.text()}`);
    const { tenantId } = WhoamiSchema.parse(await signedUp.json()).tenant;
    return { tenantId, ...(await this.device(tenantId, email)) };
  }

  async device(tenantId: string, email: string): Promise<{ token: string; bearer: Record<string, string> }> {
    const started = DeviceAuthorizationSchema.parse(
      await (await this.postJson("/v1/device/code", { device_name: `${email} scenario` })).json(),
    );
    const approved = await this.postJson(
      "/v1/device/approve",
      { userCode: started.user_code, tenantId },
      this.browser(email),
    );
    if (approved.status !== 200)
      throw new Error(`approving the device answered ${approved.status}: ${await approved.text()}`);
    await this.passes(started.interval * 1000);
    const granted = await this.postJson("/v1/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: started.device_code,
    });
    if (granted.status !== 200) throw new Error(`the device token answered ${granted.status}: ${await granted.text()}`);
    const token = DeviceTokenSchema.parse(await granted.json()).access_token;
    return { token, bearer: { authorization: `Bearer ${token}` } };
  }

  async callTenant(tenantId: string, operation: string, input: unknown): Promise<unknown> {
    const result = await this.tenantApi(this.tenants, tenantId).call(operation, input);
    await this.settle();
    return result;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await request(`${this.origin}${path}`, init);
    await this.settle();
    return response;
  }

  async settle(): Promise<void> {
    await settle(this.runtime);
  }

  async tick(ms: number): Promise<void> {
    mock.timers.tick(ms);
    await this.settle();
  }

  until<T>(what: string, read: () => Promise<T> | T, done: (value: T) => boolean): Promise<T> {
    return until(this, what, read, done);
  }

  private storageOf(member: Member): Storage {
    return this.tenantStorage(member.tenantId);
  }

  tenantStorage(tenantId: string): Storage {
    const held = this.tenants.instances.get(tenantId);
    if (held === undefined) throw new Error(`tenant ${tenantId} has no Durable Object yet`);
    return held.ctx.storage;
  }

  hostStorage(hostId: string): Storage {
    const held = this.hostChannels.instances.get(hostId);
    if (held === undefined) throw new Error(`host ${hostId} has no channel Durable Object yet`);
    return held.ctx.storage;
  }

  hostRows(hostId: string): number {
    return this.hostStorage(hostId).sql.rowsWritten;
  }

  hibernateHostChannel(hostId: string): void {
    this.hostChannels.hibernate(hostId);
  }

  rowsWritten(member: Member): number {
    return this.storageOf(member).sql.rowsWritten;
  }

  events(member: Member): string[] {
    return this.storageOf(member)
      .sql.db.prepare("SELECT payload FROM events ORDER BY event_id")
      .all()
      .map((row) => z.object({ event: z.string() }).parse(JSON.parse(String(row.payload))).event);
  }

  async usage(member: Member): Promise<TenantUsage> {
    const read = await this.tenantApi(this.env.TENANT, member.tenantId).call("readUsage", {
      tenantId: member.tenantId,
    });
    return z.object({ usage: TenantUsageSchema }).parse(read).usage;
  }

  host(hostId: string): Host {
    const held = this.hosts.get(hostId);
    if (held === undefined) throw new Error(`no supervisor connected as host ${hostId}`);
    return held;
  }

  async call(operation: string, input: unknown): Promise<unknown> {
    const result = await this.api.call(operation, input);
    await this.settle();
    return result;
  }

  async enrol(
    member: Member,
    name: string,
    key = hostKey(),
  ): Promise<{ hostId: string; key: ReturnType<typeof hostKey> }> {
    const minted = await this.fetch(member, "POST", "/v1/enrolment-tokens", JSON.stringify({ expiresInSeconds: 600 }));
    if (minted.status !== 200)
      throw new Error(`minting an enrolment token answered ${minted.status}: ${await minted.text()}`);
    const { token } = MintedEnrolmentTokenSchema.parse(await minted.json());
    const enrolled = await this.request("/v1/hosts/enrol", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrolmentToken: token,
        name,
        architecture: "Amd64",
        cpuCount: 8,
        memoryBytes: 32 * 1024 ** 3,
        publicKey: key.publicKey,
        supervisorVersion: "0.1.0",
      }),
    });
    if (enrolled.status !== 200) throw new Error(`enrolling answered ${enrolled.status}: ${await enrolled.text()}`);
    return { hostId: HostRecordSchema.parse(await enrolled.json()).hostId, key };
  }

  async connect(
    hostId: string,
    key: ReturnType<typeof hostKey>,
    options: Partial<Omit<SupervisorOptions, "store">> = {},
  ): Promise<Supervisor> {
    const supervisor = await Supervisor.connect(this, this.origin, hostId, key.privateKey, {
      heartbeatMs: this.settings.heartbeatIntervalSeconds * 1000,
      store: this.store,
      ...options,
    });
    this.hosts.get(hostId)?.quiet();
    this.hosts.set(hostId, supervisor);
    return supervisor;
  }

  async reconnect(host: Supervisor, options: Partial<SupervisorOptions> = {}): Promise<Supervisor> {
    const supervisor = await host.reconnect(options);
    this.hosts.set(host.hostId, supervisor);
    return supervisor;
  }

  async online(
    member: Member,
    name: string,
    options: Partial<Omit<SupervisorOptions, "store">> = {},
  ): Promise<Supervisor> {
    const { hostId, key } = await this.enrol(member, name);
    const supervisor = await this.connect(hostId, key, options);
    await this.until(
      `host ${hostId} reading Online`,
      () => this.db.sql.exec("SELECT state FROM hosts WHERE host_id = ?", hostId).toArray()[0]?.state,
      (state) => state === "Online" && supervisor.isWelcomed(),
    );
    return supervisor;
  }

  async computeMs(operation: string, input: unknown): Promise<number> {
    const spent = ioClock.spentMs;
    const started = performance.now();
    await this.api.call(operation, input).catch((error: unknown) => {
      if (error instanceof Error && /as invalid:/.test(error.message)) throw error;
    });
    const elapsed = performance.now() - started - (ioClock.spentMs - spent);
    await this.runtime.settle();
    return elapsed;
  }

  hostOnline(name: string): Promise<Host> {
    return this.online(this.owner, name);
  }

  async restartTenant(tenantId: string = TENANT_ID): Promise<void> {
    this.tenants.restart(tenantId);
    await this.runtime.settle();
  }

  tenantRowsWritten(): number {
    return this.tenants.instance(TENANT_ID).ctx.storage.sql.rowsWritten;
  }

  private async defaultPersona(): Promise<string> {
    const personas = z
      .object({ personas: z.array(z.object({ personaId: z.string() })) })
      .parse(await this.call("listPersonas", { tenantId: TENANT_ID }));
    const [persona] = personas.personas;
    if (persona === undefined) throw new Error("the tenant opened without a default persona");
    return persona.personaId;
  }

  async holdsAgentCredentials(): Promise<void> {
    const personas = z
      .object({ personas: z.array(z.object({ secretSetId: z.string() })) })
      .parse(await this.call("listPersonas", { tenantId: TENANT_ID }));
    const [persona] = personas.personas;
    if (persona === undefined) throw new Error("the tenant opened without a default persona");
    const members = [
      { kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic", value: "sk-ant-scenario" },
      { kind: "Variable", name: "GITHUB_TOKEN", value: "ghp-scenario" },
    ];
    for (const member of members) {
      await this.call("setSecretMember", {
        tenantId: TENANT_ID,
        secretSetId: persona.secretSetId,
        member,
        githubUser: member.kind === "Variable" ? { githubUserId: 1, login: "scenario" } : null,
        now: Date.now(),
      });
    }
  }

  async startPrebuild(): Promise<void> {
    const listHosts = await imported<(env: unknown, tenantId: string) => Promise<HostRecord[]>>(
      "hosts.ts",
      "listHostRecords",
    );
    await installApp(this.db, TENANT_ID, "acme");
    const personaId = await this.defaultPersona();
    const prebuildId = randomUUID();
    const [base] = CLAUDE_CODE_AMD64_RELEASE.bases;
    if (base === undefined) throw new Error("the release fixture carries no base image");
    await this.call("startHostPrebuild", {
      tenantId: TENANT_ID,
      commit: {
        prebuildId,
        personaId,
        key: { repository: REPOSITORY, inputDigest: "7".repeat(64), guestImageDigest: base.imageDigest },
        configSource: "RepositoryFile",
        defaultBranch: "main",
        headSha: "8".repeat(40),
        rootfsKey: "rootfs/scenario",
      },
      input: {
        principalId: PRINCIPAL_ID,
        startedBy: { kind: "Person", principalId: PRINCIPAL_ID },
        hosts: await listHosts(this.env, TENANT_ID),
        harness: "ClaudeCode",
        harnessVersion: CLAUDE_CODE_VERSION,
        endpoint: "https://api.scenario.test",
        start: {
          personaId,
          repository: REPOSITORY,
          model: "prebuild",
          prompt: `Run the setup step for prebuild ${prebuildId}`,
        },
      },
      apiOrigin: "https://api.scenario.test",
      now: Date.now(),
    });
  }

  async startSession(start: { prompt: string; tags: string[] }): Promise<Session> {
    const answer = z
      .object({ started: z.object({ kind: z.literal("Started"), started: StartedSessionSchema }) })
      .parse(await this.tryStartSession(start));
    return answer.started.started.session;
  }

  async tryStartSession(start: { prompt: string; tags: string[] }): Promise<unknown> {
    const listHosts = await imported<(env: unknown, tenantId: string) => Promise<HostRecord[]>>(
      "hosts.ts",
      "listHostRecords",
    );
    const personaId = await this.defaultPersona();
    return this.call("startSession", {
      tenantId: TENANT_ID,
      now: Date.now(),
      input: {
        principalId: PRINCIPAL_ID,
        startedBy: { kind: "Person", principalId: PRINCIPAL_ID },
        hosts: await listHosts(this.env, TENANT_ID),
        harness: "ClaudeCode",
        harnessVersion: CLAUDE_CODE_VERSION,
        endpoint: "https://api.scenario.test",
        start: {
          personaId,
          repository: REPOSITORY,
          model: "opus",
          prompt: start.prompt,
          boxRetention: "Auto",
          tags: start.tags,
        },
      },
    });
  }

  async sendTurn(sessionId: string, prompt: string): Promise<{ turnId: string }> {
    const listHosts = await imported<(env: unknown, tenantId: string) => Promise<HostRecord[]>>(
      "hosts.ts",
      "listHostRecords",
    );
    return z.object({ sent: z.object({ kind: z.literal("Sent"), turn: z.object({ turnId: z.string() }) }) }).parse(
      await this.call("sendTurn", {
        tenantId: TENANT_ID,
        sessionId,
        send: { prompt },
        hosts: await listHosts(this.env, TENANT_ID),
        now: Date.now(),
      }),
    ).sent.turn;
  }

  async session(sessionId: string): Promise<Session> {
    return z.object({ session: SessionSchema }).parse(await this.call("getSession", { tenantId: TENANT_ID, sessionId }))
      .session;
  }

  async subscribe(
    session: Session,
    subscription: { prompt: string; goal: string; events: string[]; crewTags: string[] },
  ): Promise<Subscription> {
    const created = z
      .object({ created: z.object({ kind: z.literal("Created"), subscription: SubscriptionSchema }) })
      .parse(
        await this.call("createSubscription", {
          tenantId: TENANT_ID,
          now: Date.now(),
          subscription: {
            sessionId: session.sessionId,
            expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
            ...subscription,
          },
        }),
      );
    return created.created.subscription;
  }

  async turn(turnId: string): Promise<Turn> {
    return z.object({ turn: TurnSchema }).parse(await this.call("getTurn", { tenantId: TENANT_ID, turnId })).turn;
  }

  async subscription(subscriptionId: string): Promise<Subscription> {
    return z
      .object({ subscription: SubscriptionSchema })
      .parse(await this.call("getSubscription", { tenantId: TENANT_ID, subscriptionId })).subscription;
  }

  tenantOperations(): TenantOperations {
    return (this.tenants.instance(TENANT_ID).object as { operations: TenantOperations }).operations;
  }

  tenantSteps(): TenantSteps {
    return this.tenants.instance(TENANT_ID).object as TenantSteps;
  }

  tenantSql(): SqlStorage {
    return this.tenants.instance(TENANT_ID).ctx.storage.sql;
  }

  async transcript(
    sessionId: string,
    query: { after?: number; turnId?: string; limit?: number },
  ): Promise<{ lines: { lineSeq: number; turnId: string }[]; cursor: number; finished: boolean }> {
    const readTranscript = await imported<
      (env: unknown, caller: unknown, sessionId: string, query: unknown) => Promise<unknown>
    >("sessions.ts", "readTranscript");
    const outcome = await readTranscript(
      this.env,
      { tenantId: TENANT_ID, principalId: PRINCIPAL_ID },
      sessionId,
      query,
    );
    return z
      .object({
        ok: z.literal(true),
        value: z.object({
          lines: z.array(z.object({ lineSeq: z.number(), turnId: z.string() })),
          cursor: z.number(),
          finished: z.boolean(),
        }),
      })
      .parse(outcome).value;
  }

  async passes(ms: number): Promise<void> {
    await this.settle();
    for (let left = ms; left > 0; left -= STEP_MS) await this.tick(Math.min(STEP_MS, left));
  }

  async close(): Promise<void> {
    for (const host of this.hosts.values()) host.quiet();
    await this.server?.close();
    await this.github?.close();
    await this.access?.close();
    await this.dispatcher.destroy();
    await this.runtime.settle();
    const faults = flight.faults;
    flight.reset();
    this.runtime.close();
    assert.deepEqual(faults, [], "a Durable Object or the Worker threw during the scenario");
  }
}
