import {
  BoxDiskLimit,
  BoxMemoryLimit,
  type HarnessPinCreateSchema,
  HarnessPinSchema,
  type PersonaPatchChangeSchema,
  type SecretSetCreateSchema,
  type SecretSetPatchSchema,
  SecretSetSchema,
  type SecretSetUpdateSchema,
  TenantTierSchema,
} from "@tumpel/schemas";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { ConfigWrite } from "./configs.ts";
import { tenantLimits, tenants } from "./db/central-schema.ts";
import { centralDb } from "./db/client.ts";
import { migrateDurableObject } from "./durable-migrate";
import { seal, unseal } from "./envelope.ts";
import { type GitHubUser, REPOSITORY_TOKEN } from "./github.ts";
import type { Env } from "./index";
import { type LegacyMember, legacyMembers, type PlaintextRow } from "./legacy-secrets.ts";
import {
  customProfileOf,
  effectiveLimits,
  limitsOf,
  type TenantLimitsProfile,
  type TenantLimitsView,
  type TenantTier,
  windowStart,
} from "./limits.ts";
import { meteredState } from "./metered-state.ts";
import { type StoredFile, type StoredPersona, StoredPersonaSchema } from "./persona-files";
import type { WriteRateRefusal } from "./rate-limit.ts";
import {
  type MemberUpdate,
  memberWith,
  type PlannedMember,
  planUpdate,
  storedKeys,
  type UnreadableSecretSet,
} from "./secret-members.ts";
import { checkStart } from "./sessions.ts";
import {
  recordSupervisorUpdate,
  type SupervisorUpdateMessage,
  type SupervisorUpdates,
  supervisorUpdatesByHost,
} from "./supervisor-updates";
import {
  serveTenantRequest,
  type TenantHandlers,
  type TenantInput,
  type TenantRequest,
  type TenantResponse,
} from "./tenant-api.ts";
import { TenantConnectors } from "./tenant-connectors.ts";
import { appendEvent, listEvents } from "./tenant-events.ts";
import { TENANT_MIGRATIONS } from "./tenant-migrations";
import { memberRows, sealContext } from "./tenant-sessions";
import { type SavedCounter, UsageMeter } from "./usage-meter.ts";
import { webhookSenderName } from "./webhook-sender.ts";

export type PersonaWrite = Pick<
  StoredPersona,
  "name" | "harness" | "secretSetId" | "connectorIds" | "boxRetention" | "tumpelMcp"
> & {
  boxMemoryMib: number;
  boxDiskMib: number;
  files: StoredFile[];
};
export type PersonaChange = Omit<PersonaWrite, "harness">;
export type SecretSet = z.infer<typeof SecretSetSchema>;
export type SecretSetWrite = z.infer<typeof SecretSetCreateSchema>;
export type SecretSetChange = z.infer<typeof SecretSetUpdateSchema>;
export type PersonaPatch = z.infer<typeof PersonaPatchChangeSchema>;
export type SecretSetPatch = z.infer<typeof SecretSetPatchSchema>;
export type HarnessPin = z.infer<typeof HarnessPinSchema>;
export type HarnessPinWrite = z.infer<typeof HarnessPinCreateSchema>;

export type Written<T> = { ok: true; value: T } | { ok: false; constraint: string };

export type ConfigApplied =
  | { kind: "Applied" }
  | { kind: "Conflict"; constraint: string }
  | { kind: "Deleted"; resource: string };

const sealedOf = (sealed: Map<string, SealedMember[]>, secretSetId: string): SealedMember[] => {
  const members = sealed.get(secretSetId);
  if (members === undefined) throw new Error(`secret set ${secretSetId} reached the config write unsealed`);
  return members;
};

export type SecretSetDeleted = { kind: "Deleted" } | { kind: "NotFound" } | { kind: "InUse"; personas: string[] };

export type SecretSetsRead = { kind: "Read"; secretSets: SecretSet[] } | UnreadableSecretSet;

export type SecretSetRead = { kind: "Found"; secretSet: SecretSet } | { kind: "NotFound" } | UnreadableSecretSet;

export type SecretSetUpdated =
  | { kind: "Updated"; secretSet: SecretSet }
  | { kind: "SetNotFound" }
  | { kind: "Conflict"; constraint: string }
  | { kind: "NoStoredValue"; name: string; source: string }
  | { kind: "UncheckedToken"; source: string };

export type SecretMemberSet =
  | { kind: "Set"; secretSet: SecretSet }
  | { kind: "SetNotFound" }
  | { kind: "Conflict"; constraint: string }
  | UnreadableSecretSet;

export type SecretMemberRemoved =
  | { kind: "Removed"; secretSet: SecretSet }
  | { kind: "SetNotFound" }
  | { kind: "MemberNotFound" }
  | UnreadableSecretSet;

export type PersonaDeleted = { kind: "Deleted" } | { kind: "NotFound" } | { kind: "InUse"; sessions: string[] };

type SecretMember = SecretSetWrite["secrets"][number];

type SealedMember = { member: MemberUpdate; sealed: string; updatedAt: number };

const UNIQUE_FAILED = "UNIQUE constraint failed: ";

const uniquely = <T>(write: () => T): Written<T> => {
  try {
    return { ok: true, value: write() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const at = error.message.indexOf(UNIQUE_FAILED);
    if (at === -1) throw error;
    return { ok: false, constraint: error.message.slice(at + UNIQUE_FAILED.length).split(":")[0] ?? "" };
  }
};

const DEFAULT_PERSONA = { name: "Default", harness: "ClaudeCode" };
const DEFAULT_SECRET_SET = "Default";

type PersonaRow = {
  persona_id: string;
  tenant_id: string;
  name: string;
  harness: string;
  secret_set_id: string;
  box_memory_mib: number;
  box_disk_mib: number;
  box_retention: string;
  tumpel_mcp: number;
  created_at: number;
  updated_at: number;
};

type PersonaFileRow = {
  path: string;
  digest: string;
  size_bytes: number;
  created_at: number;
  updated_at: number;
};

const PERSONA_SELECT =
  "SELECT persona_id, tenant_id, name, harness, secret_set_id, box_memory_mib, box_disk_mib, box_retention, tumpel_mcp, created_at, updated_at FROM personas";

export const personaFileRows = (sql: SqlStorage, personaId: string): PersonaFileRow[] =>
  sql
    .exec<PersonaFileRow>(
      "SELECT path, digest, size_bytes, created_at, updated_at FROM persona_files WHERE persona_id = ? ORDER BY path",
      personaId,
    )
    .toArray();

const toPersona = (row: PersonaRow, files: PersonaFileRow[], connectorIds: string[]): StoredPersona =>
  StoredPersonaSchema.parse({
    connectorIds,
    personaId: row.persona_id,
    tenantId: row.tenant_id,
    name: row.name,
    harness: row.harness,
    secretSetId: row.secret_set_id,
    boxMemoryMib: row.box_memory_mib,
    boxDiskMib: row.box_disk_mib,
    boxRetention: row.box_retention,
    tumpelMcp: row.tumpel_mcp === 1,
    files: files.map((file) => ({
      path: file.path,
      digest: file.digest,
      sizeBytes: file.size_bytes,
      createdAt: file.created_at,
      updatedAt: file.updated_at,
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

type SecretSetRow = { secret_set_id: string; name: string; created_at: number; updated_at: number };
type HarnessPinRow = { harness: string; harness_version: string; updated_at: number };

const toPin = (row: HarnessPinRow): HarnessPin =>
  HarnessPinSchema.parse({ harness: row.harness, harnessVersion: row.harness_version, updatedAt: row.updated_at });

const USAGE_KEY = "usage";

type StoredLimits = { tier: TenantTier; custom: TenantLimitsProfile | null };

const storedLimitsOf = async (db: D1Database, tenantId: string, fallback: TenantTier): Promise<StoredLimits> => {
  const row = await centralDb(db)
    .select({ tier: tenants.tier, profile: tenantLimits.profile })
    .from(tenants)
    .leftJoin(tenantLimits, eq(tenantLimits.tenantId, tenants.tenantId))
    .where(eq(tenants.tenantId, tenantId))
    .get();
  if (row === undefined) return { tier: fallback, custom: null };
  return { tier: TenantTierSchema.parse(row.tier), custom: customProfileOf(row.profile) };
};

type WriteWindow = { start: number; writes: number };

const UNMETERED = new Set(["readUsage", "readLimits", "setLimits"]);

export class Tenant extends TenantConnectors {
  private readonly cursors: { readonly rowsRead: number; readonly rowsWritten: number }[];
  private meter: UsageMeter | undefined;
  private tier: TenantTier;
  private limits: TenantLimitsView;
  private writeWindow: WriteWindow = { start: 0, writes: 0 };
  private tierRead: Promise<void> | null = null;
  private readonly opened: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    const cursors: { readonly rowsRead: number; readonly rowsWritten: number }[] = [];
    super(ctx, env);
    this.ctx = meteredState(this.ctx, cursors);
    this.cursors = cursors;
    this.tier = limitsOf(env).defaultTier;
    this.limits = effectiveLimits(limitsOf(env), this.tier, null);
    this.opened = this.ctx.blockConcurrencyWhile(async () => {
      await migrateDurableObject(this.ctx.storage, TENANT_MIGRATIONS);
      await this.holdDataKey();
      await this.sealPlaintext();
      await this.openMeter();
    });
  }

  private async openMeter(): Promise<void> {
    const tenantId = this.ctx.id.name;
    if (tenantId === undefined) return;
    const saved = (await this.ctx.storage.get<SavedCounter[]>(USAGE_KEY)) ?? [];
    this.meter = new UsageMeter(this.tier, this.limits.profile.usage, saved, this.cursors, Date.now());
  }

  private settleTier(): Promise<void> {
    this.tierRead ??= this.readTier().catch((error: unknown) => {
      this.tierRead = null;
      throw error;
    });
    return this.tierRead;
  }

  private async readTier(): Promise<void> {
    const { defaultTier } = limitsOf(this.env);
    const stored = await storedLimitsOf(this.env.DB, this.tenantName(), defaultTier);
    this.relimit(stored);
  }

  private relimit(stored: StoredLimits): void {
    this.tier = stored.tier;
    this.limits = effectiveLimits(limitsOf(this.env), stored.tier, stored.custom);
    this.usageMeter().retier(stored.tier, this.limits.profile.usage, Date.now());
  }

  private writeRateRefusal(writes: number, now: number): WriteRateRefusal | null {
    if (writes === 0) return null;
    const start = windowStart("Minute", now);
    if (this.writeWindow.start !== start) this.writeWindow = { start, writes: 0 };
    const { writesPerMinute } = this.limits.profile;
    if (this.writeWindow.writes + writes > writesPerMinute) {
      return {
        writeRateLimited: `tenant ${this.tenantName()} sent more than ${writesPerMinute} writing requests in a minute`,
      };
    }
    this.writeWindow.writes += writes;
    return null;
  }

  private async setLimits({ tenantId }: TenantInput<"setLimits">): Promise<TenantLimitsView> {
    this.relimit(await storedLimitsOf(this.env.DB, tenantId, limitsOf(this.env).defaultTier));
    return this.limits;
  }

  private usageMeter(): UsageMeter {
    if (this.meter === undefined) throw new Error("the tenant Durable Object has no usage meter; it has no name");
    return this.meter;
  }

  private async meterUsage(operation: string | null): Promise<void> {
    const meter = this.usageMeter();
    const now = Date.now();
    for (const signal of meter.count(operation, now)) {
      if (signal.event === "UsageLimitReached") {
        console.error(
          `UsageLimitReached: tenant ${this.tenantName()} on the ${signal.tier} tier spent its limit of ${signal.limit} ${signal.measure} per ${signal.window.toLowerCase()}; it is refused until ${signal.resetsAt}`,
        );
      }
      appendEvent(this.ctx.storage.sql, signal, now);
      this.eventsAppended = true;
    }
    const saved = meter.saveDue(now);
    if (saved !== null) await this.ctx.storage.put(USAGE_KEY, saved);
  }

  async handle(request: TenantRequest): Promise<TenantResponse> {
    await this.opened;
    await this.settleTier();
    return this.serve(request, null);
  }

  async handleForTenant(request: TenantRequest, writes: number): Promise<TenantResponse | WriteRateRefusal> {
    await this.opened;
    const operation = typeof request.operation === "string" ? request.operation : "";
    await this.settleTier();
    const refused = this.writeRateRefusal(writes, Date.now());
    if (refused !== null) return refused;
    const spent = UNMETERED.has(operation) ? null : this.usageMeter().spent(operation, Date.now());
    if (spent !== null) return spent;
    return this.serve(request, operation);
  }

  private async serve(request: TenantRequest, operation: string | null): Promise<TenantResponse> {
    this.expireSubscriptions(Date.now());
    const response = await serveTenantRequest(request, this.operations, () =>
      this.ctx.abort("Tenant API reset onto the deployed code"),
    );
    await this.meterUsage(operation);
    await this.startDeliveries(this.tenantName());
    this.wakeEvents();
    this.wakeWebhooks();
    this.ctx.waitUntil(this.deliverPushes(this.tenantName()));
    return response;
  }

  private tenantName(): string {
    const tenantId = this.ctx.id.name;
    if (tenantId === undefined) throw new Error("the tenant Durable Object has no name");
    return tenantId;
  }

  private wakeEvents(): void {
    if (!this.eventsAppended) return;
    this.eventsAppended = false;
    this.ctx.waitUntil(this.env.EVENTS.getByName(this.tenantName()).wake());
  }

  private wakeWebhooks(): void {
    const tenantId = this.tenantName();
    for (const wake of this.takeWebhookWakes()) {
      this.ctx.waitUntil(
        this.env.WEBHOOKS.getByName(webhookSenderName(tenantId, wake.webhookEndpointId)).wake({ tenantId, ...wake }),
      );
    }
  }

  private readonly operations: TenantHandlers = {
    listPersonas: ({ tenantId }) => ({ personas: this.listPersonas(tenantId) }),
    getPersona: ({ tenantId, personaId }) => ({ persona: this.getPersona(tenantId, personaId) }),
    createPersona: ({ tenantId, persona, now }) => ({ written: this.createPersona(tenantId, persona, now) }),
    updatePersona: ({ tenantId, personaId, persona, now }) => ({
      written: this.updatePersona(tenantId, personaId, persona, now),
    }),
    patchPersona: ({ tenantId, personaId, patch, now }) => ({
      written: this.patchPersona(tenantId, personaId, patch, now),
    }),
    deletePersona: async ({ tenantId, personaId }) => ({ deleted: await this.deletePersona(tenantId, personaId) }),
    open: ({ tenantId, now }) => {
      this.open(tenantId, now);
      return {};
    },
    supervisorUpdate: ({ hostId, message }) => {
      this.supervisorUpdate(hostId, message);
      return {};
    },
    supervisorUpdates: ({ hostIds }) => ({ byHost: this.supervisorUpdates(hostIds) }),
    listSecretSets: ({ tenantId }) => ({ read: this.listSecretSets(tenantId) }),
    getSecretSet: ({ tenantId, secretSetId }) => ({ read: this.getSecretSet(tenantId, secretSetId) }),
    createSecretSet: async ({ tenantId, secretSet, githubUser, now }) => ({
      written: await this.createSecretSet(tenantId, secretSet, githubUser, now),
    }),
    updateSecretSet: async ({ tenantId, secretSetId, change, githubUser, now }) => ({
      updated: await this.updateSecretSet(tenantId, secretSetId, change, githubUser, now),
    }),
    patchSecretSet: async ({ tenantId, secretSetId, patch, githubUser, now }) => ({
      patched: await this.patchSecretSet(tenantId, secretSetId, patch, githubUser, now),
    }),
    setSecretMember: async ({ tenantId, secretSetId, member, githubUser, now }) => ({
      set: await this.setSecretMember(tenantId, secretSetId, member, githubUser, now),
    }),
    removeSecretMember: ({ tenantId, secretSetId, name, now }) => ({
      removed: this.removeSecretMember(tenantId, secretSetId, name, now),
    }),
    deleteSecretSet: ({ secretSetId }) => ({ deleted: this.deleteSecretSet(secretSetId) }),
    applyConfig: async ({ tenantId, writes, now }) => ({ applied: await this.applyConfig(tenantId, writes, now) }),
    listPins: () => ({ pins: this.listPins() }),
    pin: ({ pin, now }) => ({ pin: this.pin(pin, now) }),
    unpin: ({ harness }) => ({ unpinned: this.unpin(harness) }),
    listConnectors: ({ tenantId, now }) => ({ connectors: this.listConnectors(tenantId, now) }),
    getConnector: ({ tenantId, connectorId, now }) => ({ connector: this.getConnector(tenantId, connectorId, now) }),
    createConnector: ({ tenantId, auth, name, url, now }) => ({
      written: this.createConnector(tenantId, auth, name, url, now),
    }),
    renameConnector: ({ tenantId, connectorId, updatedAt, name, now }) => ({
      written: this.renameConnector(tenantId, connectorId, updatedAt, name, now),
    }),
    deleteConnector: ({ connectorId, updatedAt }) => ({ deleted: this.deleteConnector(connectorId, updatedAt) }),
    setStaticToken: async ({ tenantId, connectorId, updatedAt, value, now }) => ({
      written: await this.setStaticToken(tenantId, connectorId, updatedAt, value, now),
    }),
    clearConnectorCredential: ({ tenantId, connectorId, updatedAt, now }) => ({
      written: this.clearConnectorCredential(tenantId, connectorId, updatedAt, now),
    }),
    startConnectorAuthorization: async ({
      tenantId,
      principalId,
      connectorId,
      updatedAt,
      controlPlaneOrigin,
      now,
    }) => ({
      started: await this.startConnectorAuthorization(
        tenantId,
        principalId,
        connectorId,
        updatedAt,
        controlPlaneOrigin,
        now,
      ),
    }),
    connectorCallback: async ({ claims, stateHash, callback, initiatorIsOwner, now }) => ({
      settled: await this.connectorCallback(claims, stateHash, callback, initiatorIsOwner, now),
    }),
    serveConnectorToken: async ({ turnId, connectorId, now }) => ({
      served: await this.serveConnectorToken(turnId, connectorId, now),
    }),
    unknownConnectors: ({ connectorIds }) => ({ unknownConnectorIds: this.unknownConnectors(connectorIds) }),
    startOpenRouterAuthorization: async ({ tenantId, principalId, input, now }) => ({
      started: await this.startOpenRouterAuthorization(tenantId, principalId, input, now),
    }),
    getOpenRouterAuthorization: ({ tenantId, principalId, openRouterAuthorizationId }) => ({
      read: this.getOpenRouterAuthorization(tenantId, principalId, openRouterAuthorizationId),
    }),
    openRouterCallback: async ({ openRouterAuthorizationId, callback, now }) => ({
      settled: await this.openRouterCallback(openRouterAuthorizationId, callback, now),
    }),
    openRouterSecretSets: () => ({ names: this.openRouterSecretSets() }),
    startClaudeSetup: async ({ tenantId, input, now }) => ({
      started: await this.startClaudeSetup(tenantId, input, now),
    }),
    getClaudeSetup: async ({ tenantId, claudeSetupId, now }) => ({
      setup: await this.getClaudeSetup(tenantId, claudeSetupId, now),
    }),
    listClaudeSetups: async ({ tenantId, secretSetId, now }) => ({
      setups: await this.listClaudeSetups(tenantId, secretSetId, now),
    }),
    submitClaudeSetupCode: async ({ tenantId, claudeSetupId, code, now }) => ({
      coded: await this.submitClaudeSetupCode(tenantId, claudeSetupId, code, now),
    }),
    writeClaudeSetupToken: async ({ tenantId, claudeSetupId, credential, token, tokenExpiresAt, now }) => ({
      stored: await this.writeClaudeSetupToken(tenantId, claudeSetupId, credential, token, tokenExpiresAt, now),
    }),
    prepareClaudeSetup: async ({ tenantId, stored, hostId, now }) => ({
      prepared: await this.prepareClaudeSetup(tenantId, stored, hostId, now),
    }),
    listPrebuilds: ({ tenantId, repository }) => ({ prebuilds: this.listPrebuilds(tenantId, repository) }),
    listLatestPrebuilds: ({ tenantId }) => ({ prebuilds: this.listLatestPrebuilds(tenantId) }),
    getPrebuild: ({ tenantId, prebuildId }) => ({ prebuild: this.getPrebuild(tenantId, prebuildId) }),
    heldPrebuild: ({ tenantId, key }) => ({ prebuild: this.heldPrebuild(tenantId, key) }),
    startHostPrebuild: async ({ tenantId, commit, provider, input, apiOrigin, now }) => ({
      started: await this.startHostPrebuild(tenantId, commit, provider, input, apiOrigin, now),
    }),
    getPrebuildFailure: ({ tenantId, prebuildId }) => ({ failure: this.getPrebuildFailure(tenantId, prebuildId) }),
    repositoryReadToken: async ({ tenantId, personaId, repository, now, permissions }) => ({
      read: await this.repositoryReadToken(tenantId, personaId, repository, now, permissions),
    }),
    startSession: async ({ tenantId, input, now }) => ({ started: await this.startSession(tenantId, input, now) }),
    startSessionFromIssue: async ({ tenantId, input, issue, now }) => ({
      started: await this.startSessionFromIssue(tenantId, input, issue, now),
    }),
    sendTurn: async ({ tenantId, sessionId, send, hosts, now }) => ({
      sent: await this.sendTurn(tenantId, sessionId, send, hosts, now),
    }),
    stopSession: async ({ tenantId, sessionId, cancelledBy, now }) => ({
      stopped: await this.stopSession(tenantId, sessionId, cancelledBy, now),
    }),
    steerTurn: async ({ tenantId, turnId, steer, now }) => ({
      sent: await this.steerTurn(tenantId, turnId, steer.prompt, now),
    }),
    listSteers: ({ tenantId, turnId }) => ({ steers: this.listSteers(tenantId, turnId) }),
    takeSteers: ({ turnId }) => ({ taken: this.takeSteers(turnId) }),
    cancelTurn: ({ tenantId, turnId, cancelledBy, now }) => ({
      cancelled: this.cancelTurn(tenantId, turnId, cancelledBy, now),
    }),
    archiveSession: async ({ tenantId, sessionId, now }) => ({
      archived: await this.archiveSession(tenantId, sessionId, now),
    }),
    createSubscription: ({ tenantId, subscription, now }) => ({
      created: this.createSubscription(tenantId, subscription, now),
    }),
    listSubscriptions: ({ tenantId, filter }) => ({ subscriptions: this.listSubscriptions(tenantId, filter) }),
    getSubscription: ({ tenantId, subscriptionId }) => ({
      subscription: this.getSubscription(tenantId, subscriptionId),
    }),
    pauseSubscription: ({ tenantId, subscriptionId, message, now }) => ({
      paused: this.pauseSubscription(tenantId, subscriptionId, message, now),
    }),
    resumeSubscription: ({ tenantId, subscriptionId, now }) => ({
      resumed: this.resumeSubscription(tenantId, subscriptionId, now),
    }),
    deleteSubscription: ({ subscriptionId, now }) => ({ deleted: this.deleteSubscription(subscriptionId, now) }),
    createTrigger: ({ tenantId, trigger, principalId, now }) => ({
      created: this.createTrigger(tenantId, trigger, principalId, now),
    }),
    listTriggers: ({ tenantId }) => ({ triggers: this.listTriggers(tenantId) }),
    getTrigger: ({ tenantId, triggerId }) => ({ trigger: this.getTrigger(tenantId, triggerId) }),
    updateTrigger: ({ tenantId, triggerId, patch, principalId, now }) => ({
      updated: this.updateTrigger(tenantId, triggerId, patch, principalId, now),
    }),
    deleteTrigger: ({ triggerId }) => ({ deleted: this.deleteTrigger(triggerId) }),
    triggerFired: async (input) => ({
      fired: await this.triggerFired(input, (trigger) =>
        checkStart({
          personaId: trigger.personaId,
          persona: this.getPersona(input.tenantId, trigger.personaId),
          pins: this.listPins(),
          secretSet: (persona) => this.getSecretSet(input.tenantId, persona.secretSetId),
          model: trigger.model,
          operation: "triggers.fire",
          now: input.now,
        }),
      ),
    }),
    completeSubscription: ({ tenantId, subscriptionId, now }) => ({
      completed: this.completeSubscription(tenantId, subscriptionId, now),
    }),
    setSessionTags: ({ tenantId, sessionId, tags, now }) => ({
      tagged: this.setSessionTags(tenantId, sessionId, tags, now),
    }),
    patchSessionTags: ({ tenantId, sessionId, patch, now }) => ({
      tagged: this.patchSessionTags(tenantId, sessionId, patch, now),
    }),
    deleteSession: async ({ tenantId, sessionId }) => ({
      deleted: await this.deleteSession(tenantId, sessionId, Date.now()),
    }),
    getSession: async ({ tenantId, sessionId }) => {
      await this.failSilentHosts(tenantId, Date.now());
      return { session: this.getSession(tenantId, sessionId) };
    },
    listSessions: async ({ tenantId, filter }) => {
      await this.failSilentHosts(tenantId, Date.now());
      return { sessions: this.listSessions(tenantId, filter) };
    },
    listTurns: async ({ tenantId, sessionId }) => {
      await this.failSilentHosts(tenantId, Date.now());
      return { turns: this.listTurns(tenantId, sessionId) };
    },
    getTurn: async ({ tenantId, turnId }) => {
      await this.failSilentHosts(tenantId, Date.now());
      return { turn: this.getTurn(tenantId, turnId) };
    },
    waitTurns: async ({ tenantId, turnIds }) => {
      await this.failSilentHosts(tenantId, Date.now());
      return { waited: this.readTurns(tenantId, turnIds) };
    },
    listEvents: (input) => ({ listed: listEvents(this.ctx.storage.sql, input) }),
    listPushSubscriptions: ({ tenantId, principalId }) => ({
      subscriptions: this.listPushSubscriptions(tenantId, principalId),
    }),
    createPushSubscription: async ({ tenantId, principalId, subscription, now }) => ({
      subscription: await this.createPushSubscription(tenantId, principalId, subscription, now),
    }),
    deletePushSubscription: ({ principalId, pushSubscriptionId }) => ({
      deleted: this.deletePushSubscription(principalId, pushSubscriptionId),
    }),
    listWebhookEndpoints: ({ tenantId }) => ({ endpoints: this.listWebhookEndpoints(tenantId) }),
    createWebhookEndpoint: ({ tenantId, endpoint, now }) => ({
      endpoint: this.createWebhookEndpoint(tenantId, endpoint, now),
    }),
    getWebhookEndpoint: ({ tenantId, webhookEndpointId }) => ({
      endpoint: this.getWebhookEndpoint(tenantId, webhookEndpointId),
    }),
    deleteWebhookEndpoint: ({ webhookEndpointId }) => ({
      deleted: this.deleteWebhookEndpoint(webhookEndpointId),
    }),
    setWebhookEndpointStatus: ({ webhookEndpointId, status }) => {
      this.setWebhookEndpointStatus(webhookEndpointId, status);
      return {};
    },
    getTurnFailure: async ({ tenantId, turnId }) => {
      await this.failSilentHosts(tenantId, Date.now());
      return { failure: this.getTurnFailure(tenantId, turnId) };
    },
    listStopFailures: ({ tenantId, sessionId }) => ({ failures: this.listStopFailures(tenantId, sessionId) }),
    listSnapshots: ({ tenantId, sessionId }) => ({ snapshots: this.listSnapshots(tenantId, sessionId) }),
    listCredentialHandovers: ({ tenantId, sessionId }) => ({
      handovers: this.listCredentialHandovers(tenantId, sessionId),
    }),
    getSnapshot: ({ tenantId, snapshotId }) => ({ snapshot: this.getSnapshot(tenantId, snapshotId) }),
    transcriptCursor: async ({ tenantId, sessionId, after, turnId, limit, maxBytes }) => ({
      cursor: await this.transcriptCursor(tenantId, sessionId, after, turnId, limit, maxBytes ?? null),
    }),
    deleteBuildConnection: ({ provider }) => ({ deleted: this.deleteBuildConnection(provider) }),
    namespaceConnection: () => ({ connection: this.namespaceConnection() }),
    connectNamespace: ({ start, now }) => ({ connection: this.connectNamespace(start, now) }),
    offerSent: ({ turnId }) => {
      this.offerSent(turnId);
      return {};
    },
    hostHello: ({ hostId, boxCapacity, usage, now, channelProtocol }) => {
      this.hostHello(hostId, boxCapacity, usage, now, channelProtocol);
      return {};
    },
    hostUsage: async ({ hostId, usage, now }) => {
      await this.hostUsage(hostId, usage, now);
      return {};
    },
    reconcileHeldBoxes: async ({ tenantId, hostId, heldSessionIds, now }) => {
      await this.reconcileHeldBoxes(tenantId, hostId, heldSessionIds, now);
      return {};
    },
    forgetHostUsage: ({ hostId }) => {
      this.forgetHostUsage(hostId);
      return {};
    },
    runningTurnsByHost: () => ({ running: this.runningTurnsByHost() }),
    listHostUsage: ({ tenantId }) => ({ usage: this.listHostUsage(tenantId) }),
    readUsage: () => ({ usage: this.usageMeter().usage(Date.now()) }),
    readLimits: () => ({ limits: this.limits }),
    setLimits: async (input) => ({ limits: await this.setLimits(input) }),
    deferredOffers: async ({ tenantId, hostId }) => ({ handoffs: await this.deferredOffers(tenantId, hostId) }),
    turnMetricDimensions: ({ turnIds }) => ({ dimensions: this.turnMetricDimensions(turnIds) }),
    prepareOffer: async ({ tenantId, turnId, hostId, now }) => ({
      prepared: await this.prepareOffer(tenantId, turnId, hostId, now),
    }),
    hostPresence: async ({ tenantId, hostId, presence, now }) => {
      await this.hostPresence(tenantId, hostId, presence, now);
      if (presence === "Offline") {
        await this.failHostClaudeSetups(
          hostId,
          "NoHostOnline",
          `host ${hostId} went offline during the setup; check that its supervisor runs, then start the setup again`,
          now,
        );
      }
      return {};
    },
    hostHealth: async ({ tenantId, hostId, health, detail, now }) => {
      this.appendEvent({ event: "HostHealthChanged", hostId, health, detail }, now);
      if (health === "Healthy") return {};
      await this.failHostWork(tenantId, hostId, detail, now);
      await this.failHostClaudeSetups(hostId, "RateLimited", detail, now);
      return {};
    },
    hostMessage: async ({ tenantId, hostId, message }) => ({
      reply: await this.hostMessage(tenantId, hostId, message),
    }),
  };

  protected supervisorUpdate(hostId: string, message: SupervisorUpdateMessage): void {
    recordSupervisorUpdate(this.ctx.storage.sql, hostId, message);
  }

  protected supervisorUpdates(hostIds: string[]): Record<string, SupervisorUpdates> {
    return supervisorUpdatesByHost(this.ctx.storage.sql, hostIds);
  }

  private async sealPlaintext(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const [table] = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'secret_values_plaintext'",
      )
      .toArray();
    if (table === undefined) return;
    const rows = sql
      .exec<PlaintextRow>(
        "SELECT secret_set_id, name, provider, value, updated_at FROM secret_values_plaintext ORDER BY secret_set_id, name",
      )
      .toArray();
    if (rows.length === 0) {
      sql.exec("DROP TABLE secret_values_plaintext");
      return;
    }
    const dataKey = await this.dataKey();
    const sealed: { member: LegacyMember; sealed: string }[] = [];
    for (const member of legacyMembers(rows)) {
      sealed.push({
        member,
        sealed: await seal(dataKey, member.row.value, sealContext(member.row.secret_set_id, member.name)),
      });
    }
    this.ctx.storage.transactionSync(() => {
      for (const { member, sealed: value } of sealed) {
        sql.exec(
          "INSERT INTO secret_values (secret_set_id, name, kind, sealed, updated_at) VALUES (?, ?, ?, ?, ?)",
          member.row.secret_set_id,
          member.name,
          member.kind,
          value,
          member.row.updated_at,
        );
        if (member.kind === "ApiKey") {
          sql.exec(
            "INSERT INTO secret_credentials (secret_set_id, name, provider) VALUES (?, ?, ?)",
            member.row.secret_set_id,
            member.name,
            member.row.provider,
          );
        }
      }
      sql.exec("DROP TABLE secret_values_plaintext");
    });
  }

  protected open(tenantId: string, now: number): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const [existing] = sql.exec<{ persona_id: string }>("SELECT persona_id FROM personas LIMIT 1").toArray();
      if (existing !== undefined) return;
      const secretSetId = crypto.randomUUID();
      sql.exec(
        "INSERT INTO secret_sets (secret_set_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        secretSetId,
        DEFAULT_SECRET_SET,
        now,
        now,
      );
      sql.exec(
        "INSERT INTO personas (persona_id, tenant_id, name, harness, secret_set_id, box_memory_mib, box_disk_mib, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(),
        tenantId,
        DEFAULT_PERSONA.name,
        DEFAULT_PERSONA.harness,
        secretSetId,
        BoxMemoryLimit.DefaultMib,
        BoxDiskLimit.DefaultMib,
        now,
        now,
      );
    });
  }

  private persona(row: PersonaRow): StoredPersona {
    const sql = this.ctx.storage.sql;
    const connectorIds = sql
      .exec<{ connector_id: string }>(
        "SELECT connector_id FROM persona_connectors WHERE persona_id = ? ORDER BY rowid",
        row.persona_id,
      )
      .toArray()
      .map((each) => each.connector_id);
    return toPersona(row, personaFileRows(sql, row.persona_id), connectorIds);
  }

  protected listPersonas(tenantId: string): StoredPersona[] {
    return this.ctx.storage.sql
      .exec<PersonaRow>(`${PERSONA_SELECT} WHERE tenant_id = ? ORDER BY created_at, persona_id`, tenantId)
      .toArray()
      .map((row) => this.persona(row));
  }

  protected getPersona(tenantId: string, personaId: string): StoredPersona | null {
    const [row] = this.ctx.storage.sql
      .exec<PersonaRow>(`${PERSONA_SELECT} WHERE tenant_id = ? AND persona_id = ?`, tenantId, personaId)
      .toArray();
    return row === undefined ? null : this.persona(row);
  }

  private writeFiles(personaId: string, files: readonly StoredFile[], now: number): void {
    const sql = this.ctx.storage.sql;
    const kept = new Set(files.map((file) => file.path));
    for (const held of personaFileRows(sql, personaId).filter((row) => !kept.has(row.path))) {
      sql.exec("DELETE FROM persona_files WHERE persona_id = ? AND path = ?", personaId, held.path);
    }
    for (const file of files) {
      sql.exec(
        `INSERT INTO persona_files (persona_id, path, digest, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (persona_id, path) DO UPDATE SET digest = excluded.digest, size_bytes = excluded.size_bytes, updated_at = excluded.updated_at
        WHERE persona_files.digest != excluded.digest`,
        personaId,
        file.path,
        file.digest,
        file.sizeBytes,
        now,
        now,
      );
    }
  }

  private writeConnectors(personaId: string, connectorIds: readonly string[]): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM persona_connectors WHERE persona_id = ?", personaId);
    for (const connectorId of connectorIds) {
      sql.exec("INSERT INTO persona_connectors (persona_id, connector_id) VALUES (?, ?)", personaId, connectorId);
    }
  }

  protected createPersona(tenantId: string, persona: PersonaWrite, now: number): Written<StoredPersona> {
    const personaId = crypto.randomUUID();
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO personas (persona_id, tenant_id, name, harness, secret_set_id, box_memory_mib, box_disk_mib, box_retention, tumpel_mcp, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          personaId,
          tenantId,
          persona.name,
          persona.harness,
          persona.secretSetId,
          persona.boxMemoryMib,
          persona.boxDiskMib,
          persona.boxRetention,
          persona.tumpelMcp ? 1 : 0,
          now,
          now,
        );
        this.writeFiles(personaId, persona.files, now);
        this.writeConnectors(personaId, persona.connectorIds);
      }),
    );
    if (!written.ok) return written;
    const created = this.getPersona(tenantId, personaId);
    if (created === null) throw new Error(`persona ${personaId} was created and then not found`);
    return { ok: true, value: created };
  }

  protected updatePersona(
    tenantId: string,
    personaId: string,
    persona: PersonaChange,
    now: number,
  ): Written<StoredPersona | null> {
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        const updated = this.ctx.storage.sql.exec(
          "UPDATE personas SET name = ?, secret_set_id = ?, box_memory_mib = ?, box_disk_mib = ?, box_retention = ?, tumpel_mcp = ?, updated_at = ? WHERE tenant_id = ? AND persona_id = ?",
          persona.name,
          persona.secretSetId,
          persona.boxMemoryMib,
          persona.boxDiskMib,
          persona.boxRetention,
          persona.tumpelMcp ? 1 : 0,
          now,
          tenantId,
          personaId,
        );
        if (updated.rowsWritten === 0) return false;
        this.writeFiles(personaId, persona.files, now);
        this.writeConnectors(personaId, persona.connectorIds);
        return true;
      }),
    );
    if (!written.ok) return written;
    return { ok: true, value: written.value ? this.getPersona(tenantId, personaId) : null };
  }

  protected patchPersona(
    tenantId: string,
    personaId: string,
    patch: PersonaPatch,
    now: number,
  ): Written<StoredPersona | null> {
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        const current = this.getPersona(tenantId, personaId);
        if (current === null) return false;
        const merged = { ...current, ...patch };
        this.ctx.storage.sql.exec(
          "UPDATE personas SET name = ?, secret_set_id = ?, box_memory_mib = ?, box_disk_mib = ?, box_retention = ?, tumpel_mcp = ?, updated_at = ? WHERE tenant_id = ? AND persona_id = ?",
          merged.name,
          merged.secretSetId,
          merged.boxMemoryMib ?? BoxMemoryLimit.DefaultMib,
          merged.boxDiskMib ?? BoxDiskLimit.DefaultMib,
          merged.boxRetention,
          merged.tumpelMcp ? 1 : 0,
          now,
          tenantId,
          personaId,
        );
        if (patch.connectorIds !== undefined) this.writeConnectors(personaId, patch.connectorIds);
        return true;
      }),
    );
    if (!written.ok) return written;
    return { ok: true, value: written.value ? this.getPersona(tenantId, personaId) : null };
  }

  protected async deletePersona(tenantId: string, personaId: string): Promise<PersonaDeleted> {
    const sql = this.ctx.storage.sql;
    const sessions = sql
      .exec<{ session_id: string }>(
        "SELECT session_id FROM sessions WHERE persona_id = ? AND state NOT IN ('Failed', 'Archived') ORDER BY created_at, session_id",
        personaId,
      )
      .toArray()
      .map((row) => row.session_id);
    if (sessions.length > 0) return { kind: "InUse", sessions };
    const deleted =
      sql.exec("DELETE FROM personas WHERE tenant_id = ? AND persona_id = ?", tenantId, personaId).rowsWritten > 0;
    if (!deleted) return { kind: "NotFound" };
    return { kind: "Deleted" };
  }

  private secretSetsWhere(tenantId: string, where: string, ...bindings: string[]): SecretSetsRead {
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec<SecretSetRow>(
        `SELECT secret_set_id, name, created_at, updated_at FROM secret_sets${where} ORDER BY created_at, secret_set_id`,
        ...bindings,
      )
      .toArray();
    const secretSets: SecretSet[] = [];
    for (const row of rows) {
      const stored = storedKeys(memberRows(sql, row.secret_set_id));
      if (stored.kind === "Unreadable") {
        return {
          kind: "Unreadable",
          secretSetId: row.secret_set_id,
          name: row.name,
          member: stored.name,
          detail: stored.detail,
        };
      }
      secretSets.push(
        SecretSetSchema.parse({
          secretSetId: row.secret_set_id,
          tenantId,
          name: row.name,
          keys: stored.keys,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }),
      );
    }
    return { kind: "Read", secretSets };
  }

  protected listSecretSets(tenantId: string): SecretSetsRead {
    return this.secretSetsWhere(tenantId, "");
  }

  protected getSecretSet(tenantId: string, secretSetId: string): SecretSetRead {
    const read = this.secretSetsWhere(tenantId, " WHERE secret_set_id = ?", secretSetId);
    if (read.kind === "Unreadable") return read;
    const [secretSet] = read.secretSets;
    return secretSet === undefined ? { kind: "NotFound" } : { kind: "Found", secretSet };
  }

  private rewrittenSecretSet(tenantId: string, secretSetId: string): SecretSet {
    const read = this.getSecretSet(tenantId, secretSetId);
    if (read.kind !== "Found") throw new Error(`secret set ${secretSetId} was written and then read back ${read.kind}`);
    return read.secretSet;
  }

  private async sealMembers(
    secretSetId: string,
    secrets: readonly SecretMember[],
    now: number,
  ): Promise<SealedMember[]> {
    if (secrets.length === 0) return [];
    const dataKey = await this.dataKey();
    const sealed: SealedMember[] = [];
    for (const member of secrets) {
      sealed.push({
        member,
        sealed: await seal(dataKey, member.value, sealContext(secretSetId, member.name)),
        updatedAt: now,
      });
    }
    return sealed;
  }

  private writeGitHubUser(secretSetId: string, githubUser: GitHubUser | null, now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM secret_set_github_users WHERE secret_set_id = ?", secretSetId);
    if (githubUser === null) return;
    sql.exec(
      "INSERT INTO secret_set_github_users (secret_set_id, github_user_id, login, created_at) VALUES (?, ?, ?, ?)",
      secretSetId,
      githubUser.githubUserId,
      githubUser.login,
      now,
    );
  }

  private writeMember(secretSetId: string, { member, sealed, updatedAt }: SealedMember): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT INTO secret_values (secret_set_id, name, kind, sealed, updated_at) VALUES (?, ?, ?, ?, ?)",
      secretSetId,
      member.name,
      member.kind,
      sealed,
      updatedAt,
    );
    if (member.kind === "Variable") return;
    sql.exec(
      "INSERT INTO secret_credentials (secret_set_id, name, provider) VALUES (?, ?, ?)",
      secretSetId,
      member.name,
      member.provider,
    );
    if (member.kind === "ApiKey") return;
    sql.exec(
      "INSERT INTO secret_expiries (secret_set_id, name, expires_at) VALUES (?, ?, ?)",
      secretSetId,
      member.name,
      member.expiresAt,
    );
  }

  private writeSecrets(
    secretSetId: string,
    secrets: readonly SealedMember[],
    githubUser: GitHubUser | null,
    now: number,
  ): void {
    this.ctx.storage.sql.exec("DELETE FROM secret_values WHERE secret_set_id = ?", secretSetId);
    this.writeGitHubUser(secretSetId, githubUser, now);
    for (const member of secrets) this.writeMember(secretSetId, member);
  }

  protected async createSecretSet(
    tenantId: string,
    secretSet: SecretSetWrite,
    githubUser: GitHubUser | null,
    now: number,
  ): Promise<Written<SecretSet>> {
    const secretSetId = crypto.randomUUID();
    const sealed = await this.sealMembers(secretSetId, secretSet.secrets, now);
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO secret_sets (secret_set_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          secretSetId,
          secretSet.name,
          now,
          now,
        );
        this.writeSecrets(secretSetId, sealed, githubUser, now);
      }),
    );
    if (!written.ok) return written;
    return { ok: true, value: this.rewrittenSecretSet(tenantId, secretSetId) };
  }

  protected async updateSecretSet(
    tenantId: string,
    secretSetId: string,
    change: SecretSetChange,
    githubUser: GitHubUser | null,
    now: number,
  ): Promise<SecretSetUpdated> {
    if (!this.hasSecretSet(secretSetId)) return { kind: "SetNotFound" };
    const plan = planUpdate(memberRows(this.ctx.storage.sql, secretSetId), change.secrets);
    if (plan.kind !== "Planned") return plan;
    const sealed = await this.sealPlanned(secretSetId, plan.members, now);
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        const updated = sql.exec(
          "UPDATE secret_sets SET name = ?, updated_at = ? WHERE secret_set_id = ?",
          change.name,
          now,
          secretSetId,
        );
        if (updated.rowsWritten === 0) return false;
        sql.exec("DELETE FROM secret_values WHERE secret_set_id = ?", secretSetId);
        if (!plan.keepsGitHubUser) this.writeGitHubUser(secretSetId, githubUser, now);
        for (const member of sealed) this.writeMember(secretSetId, member);
        return true;
      }),
    );
    if (!written.ok) return { kind: "Conflict", constraint: written.constraint };
    if (!written.value) return { kind: "SetNotFound" };
    return { kind: "Updated", secretSet: this.rewrittenSecretSet(tenantId, secretSetId) };
  }

  protected async patchSecretSet(
    tenantId: string,
    secretSetId: string,
    patch: SecretSetPatch,
    githubUser: GitHubUser | null,
    now: number,
  ): Promise<SecretSetUpdated> {
    if (!this.hasSecretSet(secretSetId)) return { kind: "SetNotFound" };
    const listed = patch.secrets ?? [];
    const plan = planUpdate(memberRows(this.ctx.storage.sql, secretSetId), listed);
    if (plan.kind !== "Planned") return plan;
    const sealed = await this.sealPlanned(secretSetId, plan.members, now);
    const sources = listed.map((member) => member.previousName ?? member.name);
    const token = listed.some((member) => member.name === REPOSITORY_TOKEN || member.previousName === REPOSITORY_TOKEN);
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        const updated = sql.exec(
          "UPDATE secret_sets SET name = COALESCE(?, name), updated_at = ? WHERE secret_set_id = ?",
          patch.name ?? null,
          now,
          secretSetId,
        );
        if (updated.rowsWritten === 0) return false;
        for (const name of sources) {
          sql.exec("DELETE FROM secret_values WHERE secret_set_id = ? AND name = ?", secretSetId, name);
        }
        if (token && !plan.keepsGitHubUser) {
          this.writeGitHubUser(secretSetId, githubUser, now);
        }
        for (const member of sealed) this.writeMember(secretSetId, member);
        return true;
      }),
    );
    if (!written.ok) return { kind: "Conflict", constraint: written.constraint };
    if (!written.value) return { kind: "SetNotFound" };
    return { kind: "Updated", secretSet: this.rewrittenSecretSet(tenantId, secretSetId) };
  }

  private async sealPlanned(
    secretSetId: string,
    members: readonly PlannedMember[],
    now: number,
  ): Promise<SealedMember[]> {
    const dataKey = await this.dataKey();
    const sealed: SealedMember[] = [];
    for (const planned of members) {
      if (planned.kind === "Written") {
        const { member } = planned;
        sealed.push({
          member,
          sealed: await seal(dataKey, member.value, sealContext(secretSetId, member.name)),
          updatedAt: now,
        });
        continue;
      }
      const { update, from } = planned;
      if (from.name === update.name) {
        sealed.push({ member: update, sealed: from.sealed, updatedAt: from.updated_at });
        continue;
      }
      const value = await unseal(dataKey, from.sealed, sealContext(secretSetId, from.name));
      const member = memberWith(update, value);
      sealed.push({
        member,
        sealed: await seal(dataKey, value, sealContext(secretSetId, member.name)),
        updatedAt: now,
      });
    }
    return sealed;
  }

  protected async setSecretMember(
    tenantId: string,
    secretSetId: string,
    member: SecretMember,
    githubUser: GitHubUser | null,
    now: number,
  ): Promise<SecretMemberSet> {
    if (!this.hasSecretSet(secretSetId)) return { kind: "SetNotFound" };
    const sealed = await this.sealMembers(secretSetId, [member], now);
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        sql.exec("DELETE FROM secret_values WHERE secret_set_id = ? AND name = ?", secretSetId, member.name);
        for (const each of sealed) this.writeMember(secretSetId, each);
        if (member.name === REPOSITORY_TOKEN) this.writeGitHubUser(secretSetId, githubUser, now);
        sql.exec("UPDATE secret_sets SET updated_at = ? WHERE secret_set_id = ?", now, secretSetId);
      }),
    );
    if (!written.ok) return { kind: "Conflict", constraint: written.constraint };
    const read = this.getSecretSet(tenantId, secretSetId);
    if (read.kind === "Found") return { kind: "Set", secretSet: read.secretSet };
    return read.kind === "NotFound" ? { kind: "SetNotFound" } : read;
  }

  protected removeSecretMember(tenantId: string, secretSetId: string, name: string, now: number): SecretMemberRemoved {
    const sql = this.ctx.storage.sql;
    const removed = this.ctx.storage.transactionSync(() => {
      const deleted = sql.exec("DELETE FROM secret_values WHERE secret_set_id = ? AND name = ?", secretSetId, name);
      if (deleted.rowsWritten === 0) return false;
      if (name === REPOSITORY_TOKEN) this.writeGitHubUser(secretSetId, null, now);
      sql.exec("UPDATE secret_sets SET updated_at = ? WHERE secret_set_id = ?", now, secretSetId);
      return true;
    });
    const read = this.getSecretSet(tenantId, secretSetId);
    if (read.kind === "NotFound") return { kind: "SetNotFound" };
    if (read.kind === "Unreadable") return read;
    return removed ? { kind: "Removed", secretSet: read.secretSet } : { kind: "MemberNotFound" };
  }

  protected deleteSecretSet(secretSetId: string): SecretSetDeleted {
    const sql = this.ctx.storage.sql;
    const personas = sql
      .exec<{ name: string }>("SELECT name FROM personas WHERE secret_set_id = ? ORDER BY name", secretSetId)
      .toArray()
      .map((row) => row.name);
    if (personas.length > 0) return { kind: "InUse", personas };
    const deleted = sql.exec("DELETE FROM secret_sets WHERE secret_set_id = ?", secretSetId).rowsWritten > 0;
    return deleted ? { kind: "Deleted" } : { kind: "NotFound" };
  }

  protected hasSecretSet(secretSetId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ secret_set_id: string }>("SELECT secret_set_id FROM secret_sets WHERE secret_set_id = ?", secretSetId)
        .toArray().length > 0
    );
  }

  private writeConfig(tenantId: string, write: ConfigWrite, sealed: Map<string, SealedMember[]>, now: number): void {
    const sql = this.ctx.storage.sql;
    switch (write.kind) {
      case "CreateSecretSet":
        sql.exec(
          "INSERT INTO secret_sets (secret_set_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          write.secretSetId,
          write.secretSet.name,
          now,
          now,
        );
        this.writeSecrets(write.secretSetId, sealedOf(sealed, write.secretSetId), write.githubUser, now);
        return;
      case "RewriteSecretSet": {
        sql.exec(
          "UPDATE secret_sets SET name = ?, updated_at = ? WHERE secret_set_id = ?",
          write.secretSet.name,
          now,
          write.secretSetId,
        );
        this.writeSecrets(write.secretSetId, sealedOf(sealed, write.secretSetId), write.githubUser, now);
        return;
      }
      case "DeleteSecretSet":
        sql.exec("DELETE FROM secret_sets WHERE secret_set_id = ?", write.secretSetId);
        return;
      case "CreatePersona": {
        const personaId = crypto.randomUUID();
        sql.exec(
          "INSERT INTO personas (persona_id, tenant_id, name, harness, secret_set_id, box_memory_mib, box_disk_mib, box_retention, tumpel_mcp, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          personaId,
          tenantId,
          write.persona.name,
          write.persona.harness,
          write.persona.secretSetId,
          write.persona.boxMemoryMib,
          write.persona.boxDiskMib,
          write.persona.boxRetention,
          write.persona.tumpelMcp ? 1 : 0,
          now,
          now,
        );
        this.writeFiles(personaId, write.persona.files, now);
        this.writeConnectors(personaId, write.persona.connectorIds);
        return;
      }
      case "UpdatePersona": {
        sql.exec(
          "UPDATE personas SET name = ?, secret_set_id = ?, box_memory_mib = ?, box_disk_mib = ?, box_retention = ?, tumpel_mcp = ?, updated_at = ? WHERE tenant_id = ? AND persona_id = ?",
          write.persona.name,
          write.persona.secretSetId,
          write.persona.boxMemoryMib,
          write.persona.boxDiskMib,
          write.persona.boxRetention,
          write.persona.tumpelMcp ? 1 : 0,
          now,
          tenantId,
          write.personaId,
        );
        this.writeFiles(write.personaId, write.persona.files, now);
        this.writeConnectors(write.personaId, write.persona.connectorIds);
        return;
      }
      case "DeletePersona":
        sql.exec("DELETE FROM personas WHERE tenant_id = ? AND persona_id = ?", tenantId, write.personaId);
        return;
      case "Pin":
        this.pin(write.pin, now);
        return;
      case "Unpin":
        this.unpin(write.harness);
        return;
      case "CreateTrigger":
        this.writeConfigTrigger(null, write.trigger, write.principalId, now);
        return;
      case "UpdateTrigger":
        this.writeConfigTrigger(write.triggerId, write.trigger, write.principalId, now);
        return;
      case "DeleteTrigger":
        this.deleteTrigger(write.triggerId);
        return;
    }
  }

  private deletedDuringApply(tenantId: string, writes: ConfigWrite[]): string | null {
    const created = new Set(writes.flatMap((write) => (write.kind === "CreateSecretSet" ? [write.secretSetId] : [])));
    for (const write of writes) {
      const setId = write.kind === "CreatePersona" || write.kind === "UpdatePersona" ? write.persona.secretSetId : null;
      if (setId !== null && !created.has(setId) && !this.hasSecretSet(setId)) return `secret set ${setId}`;
      if (write.kind === "RewriteSecretSet" && !this.hasSecretSet(write.secretSetId)) {
        return `secret set ${write.secretSetId}`;
      }
      if (write.kind === "UpdatePersona" && this.getPersona(tenantId, write.personaId) === null) {
        return `persona ${write.personaId}`;
      }
    }
    return null;
  }

  protected async applyConfig(tenantId: string, writes: ConfigWrite[], now: number): Promise<ConfigApplied> {
    const sealed = new Map<string, SealedMember[]>();
    for (const write of writes) {
      if (write.kind !== "CreateSecretSet" && write.kind !== "RewriteSecretSet") continue;
      sealed.set(write.secretSetId, await this.sealMembers(write.secretSetId, write.secretSet.secrets, now));
    }
    const deleted = this.deletedDuringApply(tenantId, writes);
    if (deleted !== null) return { kind: "Deleted", resource: deleted };
    const written = uniquely(() =>
      this.ctx.storage.transactionSync(() => {
        for (const write of writes) this.writeConfig(tenantId, write, sealed, now);
      }),
    );
    if (!written.ok) return { kind: "Conflict", constraint: written.constraint };
    return { kind: "Applied" };
  }

  protected listPins(): HarnessPin[] {
    return this.ctx.storage.sql
      .exec<HarnessPinRow>("SELECT harness, harness_version, updated_at FROM harness_pins ORDER BY harness")
      .toArray()
      .map(toPin);
  }

  protected pin(pin: HarnessPinWrite, now: number): HarnessPin {
    this.ctx.storage.sql.exec(
      `INSERT INTO harness_pins (harness, harness_version, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (harness) DO UPDATE SET harness_version = excluded.harness_version, updated_at = excluded.updated_at`,
      pin.harness,
      pin.harnessVersion,
      now,
    );
    return { ...pin, updatedAt: now };
  }

  protected unpin(harness: string): boolean {
    return this.ctx.storage.sql.exec("DELETE FROM harness_pins WHERE harness = ?", harness).rowsWritten > 0;
  }
}
