import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const claudeSetups = sqliteTable(
  "claude_setups",
  {
    claudeSetupId: text("claude_setup_id").primaryKey(),
    principalId: text("principal_id").notNull(),
    secretSetId: text("secret_set_id").notNull(),
    hostId: text("host_id").notNull(),
    boxId: text("box_id").notNull(),
    harnessVersion: text("harness_version").notNull(),
    endpoint: text("endpoint").notNull(),
    state: text("state").notNull(),
    phaseDueAt: integer("phase_due_at").notNull(),
    signInUrl: text("sign_in_url"),
    sealedCode: text("sealed_code"),
    reason: text("reason"),
    detail: text("detail"),
    expiresAt: text("expires_at"),
    endedAt: integer("ended_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    harness: text("harness").notNull().default(sql`'ClaudeCode'`),
    userCode: text("user_code"),
  },
  (table) => [
    uniqueIndex("claude_setups_running")
      .on(table.secretSetId)
      .where(sql`state IN ('Starting', 'AwaitingCode', 'Minting')`),
    index("claude_setups_host").on(table.hostId, table.state),
  ],
);

export const connectorAuthorizationFailures = sqliteTable("connector_authorization_failures", {
  connectorId: text("connector_id")
    .primaryKey()
    .references((): AnySQLiteColumn => oauthConnectors.connectorId, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  detail: text("detail").notNull(),
  failedAt: integer("failed_at").notNull(),
});

export const connectorAuthorizations = sqliteTable(
  "connector_authorizations",
  {
    connectorAuthorizationId: text("connector_authorization_id").primaryKey(),
    connectorId: text("connector_id")
      .notNull()
      .references((): AnySQLiteColumn => oauthConnectors.connectorId, { onDelete: "cascade" }),
    principalId: text("principal_id").notNull(),
    stateHash: text("state_hash").notNull(),
    issuer: text("issuer").notNull(),
    tokenEndpoint: text("token_endpoint").notNull(),
    clientId: text("client_id").notNull(),
    resource: text("resource").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    verifierSealed: text("verifier_sealed").notNull(),
    callbackDueAt: integer("callback_due_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [unique().on(table.stateHash), unique().on(table.connectorId)],
);

export const connectorDisconnections = sqliteTable("connector_disconnections", {
  connectorId: text("connector_id")
    .primaryKey()
    .references((): AnySQLiteColumn => connectorNames.connectorId, { onDelete: "cascade" }),
  disconnectedAt: integer("disconnected_at").notNull(),
});

export const connectorNames = sqliteTable(
  "connector_names",
  {
    connectorId: text("connector_id").primaryKey(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique().on(table.name)],
);

export const credentialHandovers = sqliteTable(
  "credential_handovers",
  {
    credentialHandoverId: text("credential_handover_id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references((): AnySQLiteColumn => turns.turnId),
    hostId: text("host_id").notNull(),
    variableNames: text("variable_names").notNull(),
    createdAt: integer("created_at").notNull(),
    repositoryCredentialSource: text("repository_credential_source").notNull().default(sql`'None'`),
  },
  (table) => [index("credential_handovers_turn").on(table.turnId, table.createdAt)],
);

export const dataKeys = sqliteTable("data_keys", {
  dataKeyId: integer("data_key_id").primaryKey(),
  wrapped: text("wrapped").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const eventSessions = sqliteTable(
  "event_sessions",
  {
    eventId: integer("event_id")
      .primaryKey()
      .references((): AnySQLiteColumn => events.eventId, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    tags: text("tags").notNull().default(sql`'[]'`),
  },
  (table) => [index("event_sessions_session").on(table.sessionId, table.eventId)],
);

export const events = sqliteTable(
  "events",
  {
    eventId: integer("event_id").primaryKey(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("events_created_at").on(table.createdAt)],
);

export const harnessPins = sqliteTable("harness_pins", {
  harness: text("harness").primaryKey(),
  harnessVersion: text("harness_version").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const hostReports = sqliteTable("host_reports", {
  hostId: text("host_id").primaryKey(),
  boxCapacity: integer("box_capacity").notNull(),
  channelProtocol: integer("channel_protocol").notNull(),
  memoryBudgetMib: integer("memory_budget_mib").notNull(),
  memoryHeldMib: integer("memory_held_mib").notNull(),
  memoryAvailableMib: integer("memory_available_mib").notNull(),
  diskBudgetMib: integer("disk_budget_mib").notNull(),
  diskHeldMib: integer("disk_held_mib").notNull(),
  loadAverage: real("load_average").notNull(),
  heardAt: integer("heard_at").notNull(),
  createdAt: integer("created_at").notNull(),
  reportedHealth: text("reported_health").notNull().default(sql`'Healthy'`),
});

export const oauthConnectorGrants = sqliteTable("oauth_connector_grants", {
  connectorId: text("connector_id")
    .primaryKey()
    .references((): AnySQLiteColumn => oauthConnectors.connectorId, { onDelete: "cascade" }),
  issuer: text("issuer").notNull(),
  tokenEndpoint: text("token_endpoint").notNull(),
  clientId: text("client_id").notNull(),
  resource: text("resource").notNull(),
  bundleSealed: text("bundle_sealed").notNull(),
  connectedAt: integer("connected_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const oauthConnectors = sqliteTable("oauth_connectors", {
  connectorId: text("connector_id")
    .primaryKey()
    .references((): AnySQLiteColumn => connectorNames.connectorId, { onDelete: "cascade" }),
  url: text("url").notNull(),
});

export const openrouterAuthorizationCompletions = sqliteTable("openrouter_authorization_completions", {
  openrouterAuthorizationId: text("openrouter_authorization_id")
    .primaryKey()
    .references((): AnySQLiteColumn => openrouterAuthorizations.openrouterAuthorizationId, { onDelete: "cascade" }),
  completedAt: integer("completed_at").notNull(),
});

export const openrouterAuthorizationExchanges = sqliteTable("openrouter_authorization_exchanges", {
  openrouterAuthorizationId: text("openrouter_authorization_id")
    .primaryKey()
    .references((): AnySQLiteColumn => openrouterAuthorizations.openrouterAuthorizationId, { onDelete: "cascade" }),
  exchangeDueAt: integer("exchange_due_at").notNull(),
});

export const openrouterAuthorizationFailures = sqliteTable("openrouter_authorization_failures", {
  openrouterAuthorizationId: text("openrouter_authorization_id")
    .primaryKey()
    .references((): AnySQLiteColumn => openrouterAuthorizations.openrouterAuthorizationId, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  detail: text("detail").notNull(),
  failedAt: integer("failed_at").notNull(),
});

export const openrouterAuthorizationWaits = sqliteTable("openrouter_authorization_waits", {
  openrouterAuthorizationId: text("openrouter_authorization_id")
    .primaryKey()
    .references((): AnySQLiteColumn => openrouterAuthorizations.openrouterAuthorizationId, { onDelete: "cascade" }),
  authorizeUrl: text("authorize_url").notNull(),
  verifierSealed: text("verifier_sealed").notNull(),
  callbackDueAt: integer("callback_due_at").notNull(),
});

export const openrouterAuthorizations = sqliteTable("openrouter_authorizations", {
  openrouterAuthorizationId: text("openrouter_authorization_id").primaryKey(),
  principalId: text("principal_id").notNull(),
  secretSetId: text("secret_set_id").notNull(),
  keyLabel: text("key_label").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const personaConnectors = sqliteTable(
  "persona_connectors",
  {
    personaId: text("persona_id")
      .notNull()
      .references((): AnySQLiteColumn => personas.personaId, { onDelete: "cascade" }),
    connectorId: text("connector_id")
      .notNull()
      .references((): AnySQLiteColumn => connectorNames.connectorId),
  },
  (table) => [
    primaryKey({ columns: [table.personaId, table.connectorId] }),
    index("persona_connectors_connector").on(table.connectorId),
  ],
);

export const personaFiles = sqliteTable(
  "persona_files",
  {
    personaId: text("persona_id")
      .notNull()
      .references((): AnySQLiteColumn => personas.personaId, { onDelete: "cascade" }),
    path: text("path").notNull(),
    digest: text("digest").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.personaId, table.path] })],
);

export const personas = sqliteTable(
  "personas",
  {
    personaId: text("persona_id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    harness: text("harness").notNull(),
    secretSetId: text("secret_set_id")
      .notNull()
      .references((): AnySQLiteColumn => secretSets.secretSetId),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    boxDiskMib: integer("box_disk_mib").notNull().default(sql`32768`),
    boxMemoryMib: integer("box_memory_mib").notNull().default(sql`2048`),
    boxRetention: text("box_retention").notNull().default(sql`'Auto'`),
    tumpelMcp: integer("tumpel_mcp").notNull().default(sql`0`),
  },
  (table) => [index("personas_secret_set").on(table.secretSetId), uniqueIndex("personas_name").on(table.name)],
);

export const prebuildFailures = sqliteTable("prebuild_failures", {
  prebuildId: text("prebuild_id")
    .primaryKey()
    .references((): AnySQLiteColumn => prebuilds.prebuildId),
  phase: text("phase").notNull(),
  detail: text("detail").notNull(),
  fix: text("fix").notNull(),
  finishedAt: text("finished_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const prebuildLayers = sqliteTable("prebuild_layers", {
  prebuildId: text("prebuild_id")
    .primaryKey()
    .references((): AnySQLiteColumn => prebuilds.prebuildId),
  layerDigest: text("layer_digest").notNull(),
  layerSizeBytes: integer("layer_size_bytes").notNull(),
  finishedAt: text("finished_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const prebuildSessions = sqliteTable(
  "prebuild_sessions",
  {
    prebuildId: text("prebuild_id")
      .primaryKey()
      .references((): AnySQLiteColumn => prebuilds.prebuildId),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.sessionId),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [unique().on(table.sessionId)],
);

export const prebuilds = sqliteTable(
  "prebuilds",
  {
    prebuildId: text("prebuild_id").primaryKey(),
    personaId: text("persona_id").notNull(),
    repository: text("repository").notNull(),
    defaultBranch: text("default_branch").notNull(),
    inputDigest: text("input_digest").notNull(),
    guestImageDigest: text("guest_image_digest").notNull(),
    configSource: text("config_source").notNull(),
    headSha: text("head_sha").notNull(),
    rootfsKey: text("rootfs_key").notNull(),
    state: text("state").notNull(),
    startedAt: text("started_at").notNull(),
    logUrl: text("log_url").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("prebuilds_by_head").on(table.repository, table.headSha),
    index("prebuilds_key").on(table.repository, table.inputDigest, table.guestImageDigest, table.createdAt),
  ],
);

export const pushSubscriptionEvents = sqliteTable(
  "push_subscription_events",
  {
    pushSubscriptionId: text("push_subscription_id")
      .notNull()
      .references((): AnySQLiteColumn => pushSubscriptions.pushSubscriptionId, { onDelete: "cascade" }),
    event: text("event").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pushSubscriptionId, table.event] })],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    pushSubscriptionId: text("push_subscription_id").primaryKey(),
    principalId: text("principal_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    authSealed: text("auth_sealed").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("push_subscriptions_principal").on(table.principalId, table.createdAt, table.pushSubscriptionId),
    unique().on(table.endpoint),
  ],
);

export const secretCredentials = sqliteTable(
  "secret_credentials",
  {
    secretSetId: text("secret_set_id").notNull(),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.secretSetId, table.name] }),
    foreignKey({
      columns: [table.secretSetId, table.name],
      foreignColumns: [secretValues.secretSetId, secretValues.name],
    }).onDelete("cascade"),
    uniqueIndex("secret_credentials_provider").on(table.secretSetId, table.provider),
  ],
);

export const secretExpiries = sqliteTable(
  "secret_expiries",
  {
    secretSetId: text("secret_set_id").notNull(),
    name: text("name").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.secretSetId, table.name] }),
    foreignKey({
      columns: [table.secretSetId, table.name],
      foreignColumns: [secretCredentials.secretSetId, secretCredentials.name],
    }).onDelete("cascade"),
  ],
);

export const secretSetGithubUsers = sqliteTable("secret_set_github_users", {
  secretSetId: text("secret_set_id")
    .primaryKey()
    .references((): AnySQLiteColumn => secretSets.secretSetId, { onDelete: "cascade" }),
  githubUserId: integer("github_user_id").notNull(),
  login: text("login").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const secretSets = sqliteTable(
  "secret_sets",
  {
    secretSetId: text("secret_set_id").primaryKey(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique().on(table.name)],
);

export const secretValues = sqliteTable(
  "secret_values",
  {
    secretSetId: text("secret_set_id")
      .notNull()
      .references((): AnySQLiteColumn => secretSets.secretSetId, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    sealed: text("sealed").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.secretSetId, table.name] })],
);

export const secretValuesPlaintext = sqliteTable("secret_values_plaintext", {
  secretSetId: text("secret_set_id"),
  name: text("name"),
  provider: text("provider"),
  value: text("value"),
  updatedAt: integer("updated_at"),
});

export const sessionBoxMemory = sqliteTable("session_box_memory", {
  sessionId: text("session_id")
    .primaryKey()
    .references((): AnySQLiteColumn => sessions.sessionId),
  boxMemoryMib: integer("box_memory_mib").notNull(),
});

export const sessionBoxRetention = sqliteTable("session_box_retention", {
  sessionId: text("session_id")
    .primaryKey()
    .references((): AnySQLiteColumn => sessions.sessionId, { onDelete: "cascade" }),
  boxRetention: text("box_retention").notNull(),
});

export const sessionConnectors = sqliteTable(
  "session_connectors",
  {
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.sessionId),
    connectorId: text("connector_id")
      .notNull()
      .references((): AnySQLiteColumn => connectorNames.connectorId, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.connectorId] }),
    index("session_connectors_connector").on(table.connectorId),
  ],
);

export const sessionIssues = sqliteTable("session_issues", {
  sessionId: text("session_id")
    .primaryKey()
    .references((): AnySQLiteColumn => sessions.sessionId),
  issueNumber: integer("issue_number").notNull(),
  title: text("title").notNull(),
  htmlUrl: text("html_url").notNull(),
  branch: text("branch").notNull(),
});

export const sessionLayerAbsences = sqliteTable("session_layer_absences", {
  sessionId: text("session_id")
    .primaryKey()
    .references((): AnySQLiteColumn => sessions.sessionId),
  reason: text("reason").notNull(),
  detail: text("detail").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const sessionOrigins = sqliteTable("session_origins", {
  sessionId: text("session_id")
    .primaryKey()
    .references((): AnySQLiteColumn => sessions.sessionId, { onDelete: "cascade" }),
  originSessionId: text("origin_session_id").notNull(),
  originTurnId: text("origin_turn_id").notNull(),
});

export const sessionPrebuildLayers = sqliteTable("session_prebuild_layers", {
  sessionId: text("session_id")
    .primaryKey()
    .references((): AnySQLiteColumn => sessions.sessionId),
  prebuildId: text("prebuild_id")
    .notNull()
    .references((): AnySQLiteColumn => prebuildLayers.prebuildId),
  createdAt: integer("created_at").notNull(),
});

export const sessionTags = sqliteTable(
  "session_tags",
  {
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.sessionId, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.tag] }),
    index("session_tags_tag").on(table.tag, table.sessionId),
  ],
);

export const sessionTriggerOrigins = sqliteTable(
  "session_trigger_origins",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references((): AnySQLiteColumn => sessions.sessionId, { onDelete: "cascade" }),
    triggerId: text("trigger_id").notNull(),
    deliveryId: text("delivery_id").notNull(),
  },
  (table) => [unique().on(table.triggerId, table.deliveryId)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    sessionId: text("session_id").primaryKey(),
    principalId: text("principal_id").notNull(),
    hostId: text("host_id").notNull(),
    boxId: text("box_id").notNull(),
    personaId: text("persona_id").notNull(),
    repository: text("repository").notNull(),
    harness: text("harness").notNull(),
    harnessVersion: text("harness_version").notNull(),
    model: text("model").notNull(),
    state: text("state").notNull(),
    lastLineSeq: integer("last_line_seq").notNull(),
    endpoint: text("endpoint").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    boxMemoryMib: integer("box_memory_mib").notNull().default(sql`4096`),
    boxDiskMib: integer("box_disk_mib").notNull().default(sql`32768`),
  },
  (table) => [
    index("sessions_host_state").on(table.hostId, table.state),
    index("sessions_created").on(table.createdAt),
  ],
);

export const snapshotFailures = sqliteTable(
  "snapshot_failures",
  {
    snapshotId: text("snapshot_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    snapshotSeq: integer("snapshot_seq").notNull(),
    reason: text("reason").notNull(),
    detail: text("detail").notNull(),
    failedAt: text("failed_at").notNull(),
    createdAt: integer("created_at").notNull(),
    boxId: text("box_id").notNull().default(sql`''`),
    storageKey: text("storage_key").notNull().default(sql`''`),
  },
  (table) => [index("snapshot_failures_session").on(table.sessionId, table.snapshotSeq)],
);

export const snapshotRequests = sqliteTable(
  "snapshot_requests",
  {
    snapshotId: text("snapshot_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    boxId: text("box_id").notNull(),
    turnId: text("turn_id").notNull(),
    snapshotSeq: integer("snapshot_seq").notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("snapshot_requests_turn").on(table.sessionId, table.turnId)],
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    snapshotId: text("snapshot_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    boxId: text("box_id").notNull(),
    turnId: text("turn_id").notNull(),
    snapshotSeq: integer("snapshot_seq").notNull(),
    storageKey: text("storage_key").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("snapshots_session").on(table.sessionId, table.snapshotSeq)],
);

export const staticConnectorTokens = sqliteTable("static_connector_tokens", {
  connectorId: text("connector_id")
    .primaryKey()
    .references((): AnySQLiteColumn => staticConnectors.connectorId, { onDelete: "cascade" }),
  tokenSealed: text("token_sealed").notNull(),
  connectedAt: integer("connected_at").notNull(),
});

export const staticConnectors = sqliteTable("static_connectors", {
  connectorId: text("connector_id")
    .primaryKey()
    .references((): AnySQLiteColumn => connectorNames.connectorId, { onDelete: "cascade" }),
  url: text("url").notNull(),
});

export const steers = sqliteTable(
  "steers",
  {
    steerId: text("steer_id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references((): AnySQLiteColumn => turns.turnId, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    createdAt: integer("created_at").notNull(),
    delivered: integer("delivered").notNull(),
  },
  (table) => [index("steers_turn").on(table.turnId, table.createdAt)],
);

export const stopFailures = sqliteTable(
  "stop_failures",
  {
    stopFailureId: text("stop_failure_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.sessionId),
    reason: text("reason").notNull(),
    detail: text("detail").notNull(),
    failedAt: text("failed_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("stop_failures_session").on(table.sessionId, table.createdAt)],
);

export const subscriptionActives = sqliteTable("subscription_actives", {
  subscriptionId: text("subscription_id")
    .primaryKey()
    .references((): AnySQLiteColumn => subscriptions.subscriptionId, { onDelete: "cascade" }),
});

export const subscriptionCrewFailingPauses = sqliteTable("subscription_crew_failing_pauses", {
  subscriptionId: text("subscription_id")
    .primaryKey()
    .references((): AnySQLiteColumn => subscriptions.subscriptionId, { onDelete: "cascade" }),
  pausedAt: text("paused_at").notNull(),
});

export const subscriptionCrewTags = sqliteTable(
  "subscription_crew_tags",
  {
    subscriptionId: text("subscription_id")
      .notNull()
      .references((): AnySQLiteColumn => subscriptions.subscriptionId, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (table) => [primaryKey({ columns: [table.subscriptionId, table.tag] })],
);

export const subscriptionDeliveryFailedPauses = sqliteTable("subscription_delivery_failed_pauses", {
  subscriptionId: text("subscription_id")
    .primaryKey()
    .references((): AnySQLiteColumn => subscriptions.subscriptionId, { onDelete: "cascade" }),
  turnId: text("turn_id")
    .notNull()
    .references((): AnySQLiteColumn => turns.turnId, { onDelete: "cascade" }),
  pausedAt: text("paused_at").notNull(),
});

export const subscriptionEnds = sqliteTable("subscription_ends", {
  subscriptionId: text("subscription_id")
    .primaryKey()
    .references((): AnySQLiteColumn => subscriptions.subscriptionId, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  endedAt: text("ended_at").notNull(),
});

export const subscriptionEvents = sqliteTable(
  "subscription_events",
  {
    subscriptionId: text("subscription_id")
      .notNull()
      .references((): AnySQLiteColumn => subscriptions.subscriptionId, { onDelete: "cascade" }),
    event: text("event").notNull(),
  },
  (table) => [primaryKey({ columns: [table.subscriptionId, table.event] })],
);

export const subscriptionRequestedPauses = sqliteTable("subscription_requested_pauses", {
  subscriptionId: text("subscription_id")
    .primaryKey()
    .references((): AnySQLiteColumn => subscriptions.subscriptionId, { onDelete: "cascade" }),
  message: text("message").notNull(),
  pausedAt: text("paused_at").notNull(),
});

export const subscriptionRoomSignals = sqliteTable("subscription_room_signals", {
  subscriptionId: text("subscription_id")
    .primaryKey()
    .references((): AnySQLiteColumn => subscriptionRoomWaits.subscriptionId, { onDelete: "cascade" }),
  signalEventId: integer("signal_event_id").notNull(),
});

export const subscriptionRoomWaits = sqliteTable("subscription_room_waits", {
  subscriptionId: text("subscription_id")
    .primaryKey()
    .references((): AnySQLiteColumn => subscriptions.subscriptionId, { onDelete: "cascade" }),
});

export const subscriptionStartsRefusedPauses = sqliteTable("subscription_starts_refused_pauses", {
  subscriptionId: text("subscription_id")
    .primaryKey()
    .references((): AnySQLiteColumn => subscriptions.subscriptionId, { onDelete: "cascade" }),
  pausedAt: text("paused_at").notNull(),
});

export const subscriptionTurns = sqliteTable(
  "subscription_turns",
  {
    turnId: text("turn_id")
      .primaryKey()
      .references((): AnySQLiteColumn => turns.turnId, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id")
      .notNull()
      .references((): AnySQLiteColumn => subscriptions.subscriptionId, { onDelete: "cascade" }),
    composed: integer("composed").notNull().default(sql`0`),
    lastEventId: integer("last_event_id").notNull().default(sql`0`),
  },
  (table) => [index("subscription_turns_subscription").on(table.subscriptionId)],
);

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    subscriptionId: text("subscription_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.sessionId, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    goal: text("goal").notNull(),
    expiresAt: text("expires_at").notNull(),
    cursorEventId: integer("cursor_event_id").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    crewFailuresInARow: integer("crew_failures_in_a_row").notNull().default(sql`0`),
    deliveryFailuresInARow: integer("delivery_failures_in_a_row").notNull().default(sql`0`),
    startRefusalsInARow: integer("start_refusals_in_a_row").notNull().default(sql`0`),
  },
  (table) => [index("subscriptions_session").on(table.sessionId)],
);

export const supervisorUpdateLatestFailures = sqliteTable("supervisor_update_latest_failures", {
  hostId: text("host_id").primaryKey(),
  fromSha256: text("from_sha256").notNull(),
  toSha256: text("to_sha256").notNull(),
  reason: text("reason").notNull(),
  detail: text("detail").notNull(),
  outputTail: text("output_tail").notNull(),
  failedAt: text("failed_at").notNull(),
});

export const supervisorUpdateLatestSteps = sqliteTable("supervisor_update_latest_steps", {
  hostId: text("host_id").primaryKey(),
  fromSha256: text("from_sha256").notNull(),
  toSha256: text("to_sha256").notNull(),
  releaseVersion: text("release_version").notNull(),
  boxesRunning: integer("boxes_running").notNull(),
  phase: text("phase").notNull(),
  at: text("at").notNull(),
});

export const triggerConditions = sqliteTable(
  "trigger_conditions",
  {
    triggerId: text("trigger_id")
      .notNull()
      .references((): AnySQLiteColumn => triggers.triggerId, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    field: text("field").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.triggerId, table.position, table.value] })],
);

export const triggerSessionTargets = sqliteTable(
  "trigger_session_targets",
  {
    triggerId: text("trigger_id")
      .primaryKey()
      .references((): AnySQLiteColumn => triggers.triggerId, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.sessionId),
  },
  (table) => [index("trigger_session_targets_session").on(table.sessionId)],
);

export const triggers = sqliteTable(
  "triggers",
  {
    triggerId: text("trigger_id").primaryKey(),
    name: text("name").notNull(),
    source: text("source").notNull(),
    event: text("event").notNull(),
    personaId: text("persona_id").notNull(),
    model: text("model").notNull(),
    prompt: text("prompt").notNull(),
    principalId: text("principal_id").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique().on(table.name)],
);

export const turnFailures = sqliteTable("turn_failures", {
  turnId: text("turn_id")
    .primaryKey()
    .references((): AnySQLiteColumn => turns.turnId),
  sessionId: text("session_id").notNull(),
  reason: text("reason").notNull(),
  detail: text("detail").notNull(),
  failedAt: text("failed_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const turnFullImages = sqliteTable("turn_full_images", {
  turnId: text("turn_id")
    .primaryKey()
    .references((): AnySQLiteColumn => turns.turnId),
  guestImageDigest: text("guest_image_digest").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const turnGoals = sqliteTable("turn_goals", {
  turnId: text("turn_id")
    .primaryKey()
    .references((): AnySQLiteColumn => turns.turnId),
  goal: text("goal").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const turnLayeredImages = sqliteTable("turn_layered_images", {
  turnId: text("turn_id")
    .primaryKey()
    .references((): AnySQLiteColumn => turns.turnId),
  baseImageDigest: text("base_image_digest").notNull(),
  harnessLayerDigest: text("harness_layer_digest").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const turnWarnings = sqliteTable("turn_warnings", {
  turnId: text("turn_id")
    .primaryKey()
    .references((): AnySQLiteColumn => turns.turnId, { onDelete: "cascade" }),
  warning: text("warning").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const turns = sqliteTable(
  "turns",
  {
    turnId: text("turn_id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references((): AnySQLiteColumn => sessions.sessionId),
    boxId: text("box_id").notNull(),
    prompt: text("prompt").notNull(),
    state: text("state").notNull(),
    lineCount: integer("line_count").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    hostId: text("host_id").notNull().default(sql`''`),
    resultPrinted: integer("result_printed").notNull().default(sql`0`),
    offerSent: integer("offer_sent").notNull().default(sql`0`),
    unheldHeartbeats: integer("unheld_heartbeats").notNull().default(sql`0`),
  },
  (table) => [
    index("turns_in_flight").on(table.hostId, table.sessionId).where(sql`state IN ('Offered', 'Running')`),
    index("turns_offered").on(table.sessionId).where(sql`state = 'Offered'`),
    index("turns_session").on(table.sessionId, table.createdAt),
  ],
);

export const webhookEndpointEvents = sqliteTable(
  "webhook_endpoint_events",
  {
    webhookEndpointId: text("webhook_endpoint_id")
      .notNull()
      .references((): AnySQLiteColumn => webhookEndpoints.webhookEndpointId, { onDelete: "cascade" }),
    event: text("event").notNull(),
  },
  (table) => [primaryKey({ columns: [table.webhookEndpointId, table.event] })],
);

export const webhookEndpoints = sqliteTable("webhook_endpoints", {
  webhookEndpointId: text("webhook_endpoint_id").primaryKey(),
  url: text("url").notNull(),
  startEventId: integer("start_event_id").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const webhookFailings = sqliteTable("webhook_failings", {
  webhookEndpointId: text("webhook_endpoint_id")
    .primaryKey()
    .references((): AnySQLiteColumn => webhookEndpoints.webhookEndpointId, { onDelete: "cascade" }),
  detail: text("detail").notNull(),
  failingSince: text("failing_since").notNull(),
});
