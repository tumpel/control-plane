import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { register } from "node:module";
import { ChannelProtocol, SessionSchema, StartedSessionSchema, SubscriptionSchema, TurnSchema } from "@tumpel/schemas";
import { z } from "zod";
import { CLAUDE_CODE_VERSION } from "../../../src/harness-catalog.ts";
import { CLAUDE_CODE_AMD64_RELEASE } from "../../release-fixture.ts";
import { TEST_SETTINGS } from "../../timing.ts";
import { D1Database, type DurableObjectState, migratedDatabase, type Namespace, R2Bucket, Runtime, type SqlStorage } from "./runtime.ts";

register("./hooks.mjs", import.meta.url);

const SOURCE = new URL("../../../src/", import.meta.url);
const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

type DurableObjectClass = new (ctx: never, env: never) => object;
type TenantApi = { call(operation: string, input: unknown): Promise<unknown> };
type HostRecord = { hostId: string };

const imported = async <T>(path: string, name: string): Promise<T> => {
  const module: Record<string, unknown> = await import(new URL(path, SOURCE).href);
  return module[name] as T;
};

const StoredTurnOfferSchema = z.object({
  type: z.literal("TurnOffer"),
  turnId: z.string(),
  sessionId: z.string(),
  boxId: z.string(),
  prompt: z.string(),
});
export type TurnOffer = z.infer<typeof StoredTurnOfferSchema>;
type Session = z.infer<typeof SessionSchema>;
type Subscription = z.infer<typeof SubscriptionSchema>;
type Turn = z.infer<typeof TurnSchema>;

const ControlMessageSchema = z.looseObject({ type: z.string() });
type ControlMessage = z.infer<typeof ControlMessageSchema>;

const START = Date.parse("2026-11-21T11:00:00Z");
export const TENANT_ID = "tenant-scenario";
export const PRINCIPAL_ID = "principal-scenario";

export type WorldOptions = { webhookSenders: "Running" | "Unreachable"; vapidKey: "Valid" | "Unreadable" };

const VAPID = generateKeyPairSync("ec", { namedCurve: "P-256" });
const VAPID_JWK = VAPID.privateKey.export({ format: "jwk" });
const VAPID_PUBLIC_KEY = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(VAPID_JWK.x ?? "", "base64url"),
  Buffer.from(VAPID_JWK.y ?? "", "base64url"),
]).toString("base64url");

type SessionTimer = { set(tenantId: string, changes: Record<string, unknown>): Promise<void> };
type TenantOperations = Record<string, (input: never) => unknown>;
const REPOSITORY = "https://github.com/acme/app";

export const SETTINGS = TEST_SETTINGS;

export class Host {
  private readonly inbox: ControlMessage[] = [];
  private readonly lineSeqs = new Map<string, number>();
  readonly hostId: string;
  private readonly world: World;

  constructor(hostId: string, world: World) {
    this.hostId = hostId;
    this.world = world;
  }

  send(message: unknown): Promise<void> {
    this.inbox.push(ControlMessageSchema.parse(message));
    return Promise.resolve();
  }

  received(type: string): ControlMessage[] {
    return this.inbox.filter((message) => message.type === type);
  }

  take(type: string): ControlMessage {
    const at = this.inbox.findIndex((message) => message.type === type);
    if (at === -1) {
      throw new Error(
        `host ${this.hostId} was sent no ${type}; it holds ${JSON.stringify(this.inbox.map((message) => message.type))}`,
      );
    }
    const [message] = this.inbox.splice(at, 1);
    return ControlMessageSchema.parse(message);
  }

  takeOffer(): TurnOffer {
    return StoredTurnOfferSchema.parse(this.take("TurnOffer"));
  }

  async says(message: Record<string, unknown>): Promise<unknown> {
    return this.world.call("hostMessage", { tenantId: TENANT_ID, hostId: this.hostId, message });
  }

  async claims(offer: TurnOffer): Promise<void> {
    await this.says({ type: "TurnClaim", turnId: offer.turnId, boxId: offer.boxId });
  }

  async finishes(offer: TurnOffer): Promise<void> {
    await this.completes(offer);
    await this.answersSnapshot(offer.sessionId);
  }

  async completes(offer: TurnOffer): Promise<void> {
    const lineSeq = (this.lineSeqs.get(offer.sessionId) ?? 0) + 1;
    this.lineSeqs.set(offer.sessionId, lineSeq);
    const result = '{"type":"result","subtype":"success","is_error":false}';
    await this.says({ type: "TurnLine", turnId: offer.turnId, lineSeq, text: result });
    await this.says({
      type: "TurnComplete",
      turnId: offer.turnId,
      lastLineSeq: lineSeq,
      completedAt: new Date(Date.now()).toISOString(),
    });
  }

  async answersSnapshot(sessionId: string): Promise<void> {
    const request = z
      .object({ snapshotId: z.string(), sessionId: z.string(), storageKey: z.string() })
      .parse(this.take("SnapshotRequest"));
    if (request.sessionId !== sessionId) throw new Error(`the snapshot asked for is of ${request.sessionId}`);
    const manifest = JSON.stringify({ entries: [] });
    const digest = createHash("sha256").update(manifest).digest("hex");
    await this.world.store.put(`${request.storageKey.split("/")[0]}/packs/${digest}`, manifest);
    await this.world.store.put(
      request.storageKey,
      JSON.stringify({ manifest: [{ digest, packDigest: digest, offset: 0, length: manifest.length }] }),
    );
    await this.says({ type: "SnapshotDone", snapshotId: request.snapshotId, uploadedBytes: manifest.length });
  }

  async tearsDownBox(sessionId: string): Promise<string> {
    const teardown = z.object({ sessionId: z.string(), boxId: z.string() }).parse(this.take("BoxTeardown"));
    if (teardown.sessionId !== sessionId) throw new Error(`the box torn down is of ${teardown.sessionId}`);
    await this.says({ type: "BoxGone", sessionId, boxId: teardown.boxId });
    return teardown.boxId;
  }
}

type TenantSteps = {
  expireSubscriptions(now: number): void;
  prebuildDeadlineReached(tenantId: string, due: unknown): Promise<void>;
};

export class World {
  readonly store = new R2Bucket();
  readonly releases = new R2Bucket();
  readonly db = new D1Database(migratedDatabase(MIGRATIONS));
  private readonly hosts = new Map<string, Host>();
  private api!: TenantApi;
  private tenants!: Namespace<object>;
  private timers!: Namespace<SessionTimer>;
  readonly runtime: Runtime;

  private constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  static async open(options: Partial<WorldOptions> = {}): Promise<World> {
    const world = new World(new Runtime(START));
    await world.boot({ webhookSenders: "Running", vapidKey: "Valid", ...options });
    return world;
  }

  private async boot(options: WorldOptions): Promise<void> {
    const Tenant = await imported<DurableObjectClass>("tenant.ts", "Tenant");
    const SessionTimer = await imported<new (ctx: never, env: never) => SessionTimer>(
      "session-timer.ts",
      "SessionTimer",
    );
    const WebhookSender = await imported<DurableObjectClass>("webhook-sender.ts", "WebhookSender");
    const unreachable = () =>
      this.runtime.stubs(() => ({
        wake: () => Promise.reject(new Error("the webhook sender Durable Object is unreachable")),
      }));
    const tenantApi = await imported<(namespace: unknown, tenantId: string) => TenantApi>("tenant-api.ts", "tenantApi");
    const ignored = () =>
      this.runtime.stubs(() => new Proxy({}, { get: () => () => Promise.resolve(undefined) }) as object);
    const env: Record<string, unknown> = {
      DB: this.db,
      STORE: this.store,
      RELEASES: this.releases,
      SESSION_TIMER: null,
      HOST: this.runtime.stubs((hostId) => this.host(hostId)),
      EVENTS: ignored(),
      WEBHOOKS: options.webhookSenders === "Running" ? this.runtime.namespace(WebhookSender, () => env) : unreachable(),
      TENANT_METRICS: ignored(),
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
      GITHUB_API_ORIGIN: "https://github.scenario.test",
      VAPID_PRIVATE_KEY:
        options.vapidKey === "Valid"
          ? VAPID.privateKey.export({ format: "pem", type: "pkcs8" }).toString()
          : "unreadable",
      VAPID_PUBLIC_KEY,
      VAPID_SUBJECT: "mailto:notifications@scenario.test",
    };
    this.timers = this.runtime.namespace(SessionTimer, () => env);
    env.SESSION_TIMER = this.timers;
    this.tenants = this.runtime.namespace(Tenant, () => env);
    env.TENANT = this.tenants;
    this.api = tenantApi(env.TENANT, TENANT_ID);
    await this.releases.put("current.json", JSON.stringify(CLAUDE_CODE_AMD64_RELEASE));
    await this.call("open", { tenantId: TENANT_ID, now: Date.now() });
  }

  host(hostId: string): Host {
    const held = this.hosts.get(hostId);
    if (held !== undefined) return held;
    const host = new Host(hostId, this);
    this.hosts.set(hostId, host);
    return host;
  }

  async call(operation: string, input: unknown): Promise<unknown> {
    const result = await this.api.call(operation, input);
    await this.runtime.settle();
    return result;
  }

  async hostOnline(name: string): Promise<Host> {
    const hostId = randomUUID();
    const now = Date.now();
    this.db.sql.exec(
      `INSERT INTO hosts (host_id, tenant_id, name, state, architecture, cpu_count, memory_bytes, public_key, supervisor_version, created_at, updated_at)
      VALUES (?, ?, ?, 'Online', 'Amd64', 8, ?, 'key', '0.1.0', ?, ?)`,
      hostId,
      TENANT_ID,
      name,
      32 * 1024 ** 3,
      now,
      now,
    );
    await this.call("hostHello", {
      hostId,
      boxCapacity: 8,
      usage: { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000 },
      now,
      channelProtocol: ChannelProtocol.Version,
    });
    return this.host(hostId);
  }

  tenantRowsWritten(): number {
    const { ctx } = this.tenants.instance(TENANT_ID) as { ctx: DurableObjectState };
    return ctx.storage.sql.totalRowsWritten();
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
    const listHosts = await imported<(db: unknown, tenantId: string) => Promise<HostRecord[]>>("hosts.ts", "listHosts");
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
      provider: "Namespace",
      input: {
        principalId: PRINCIPAL_ID,
        startedBy: { kind: "Person", principalId: PRINCIPAL_ID },
        hosts: await listHosts(this.db, TENANT_ID),
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
    const listHosts = await imported<(db: unknown, tenantId: string) => Promise<HostRecord[]>>("hosts.ts", "listHosts");
    const personaId = await this.defaultPersona();
    const answer = z.object({ started: z.object({ kind: z.literal("Started"), started: StartedSessionSchema }) }).parse(
      await this.call("startSession", {
        tenantId: TENANT_ID,
        now: Date.now(),
        input: {
          principalId: PRINCIPAL_ID,
          startedBy: { kind: "Person", principalId: PRINCIPAL_ID },
          hosts: await listHosts(this.db, TENANT_ID),
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
      }),
    );
    return answer.started.started.session;
  }

  async sendTurn(sessionId: string, prompt: string): Promise<void> {
    const listHosts = await imported<(db: unknown, tenantId: string) => Promise<HostRecord[]>>("hosts.ts", "listHosts");
    z.object({ sent: z.object({ kind: z.literal("Sent") }) }).parse(
      await this.call("sendTurn", {
        tenantId: TENANT_ID,
        sessionId,
        send: { prompt },
        hosts: await listHosts(this.db, TENANT_ID),
        now: Date.now(),
      }),
    );
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

  sessionTimer(name: string): { timer: SessionTimer; alarm(): Promise<number | null> } {
    const { object, ctx } = this.timers.instance(name);
    return { timer: object, alarm: () => ctx.storage.getAlarm() };
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

  tenantAlarm(): Promise<number | null> {
    return this.tenants.instance(TENANT_ID).ctx.storage.getAlarm();
  }

  async passes(ms: number): Promise<void> {
    await this.runtime.advance(ms);
  }

  close(): void {
    this.runtime.close();
  }
}
