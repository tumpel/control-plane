import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const deviceApprovals = sqliteTable(
  "device_approvals",
  {
    deviceCodeSha256: text("device_code_sha256")
      .primaryKey()
      .references((): AnySQLiteColumn => deviceCodes.deviceCodeSha256, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    approvedAt: integer("approved_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
    }).onDelete("cascade"),
    index("device_approvals_by_membership").on(table.tenantId, table.principalId),
    unique().on(table.deviceId),
  ],
);

export const deviceCodes = sqliteTable(
  "device_codes",
  {
    deviceCodeSha256: text("device_code_sha256").primaryKey(),
    userCode: text("user_code").notNull(),
    deviceName: text("device_name").notNull(),
    clientIp: text("client_ip").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    intervalS: integer("interval_s").notNull(),
    lastPolledAt: integer("last_polled_at").notNull(),
  },
  (table) => [index("device_codes_by_expiry").on(table.expiresAt), unique().on(table.userCode)],
);

export const devices = sqliteTable(
  "devices",
  {
    deviceId: text("device_id").primaryKey(),
    tokenSha256: text("token_sha256").notNull(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
    }).onDelete("cascade"),
    index("devices_by_membership").on(table.tenantId, table.principalId),
    index("devices_by_tenant").on(table.tenantId, table.createdAt),
    unique().on(table.tokenSha256),
  ],
);

export const enrolmentTokens = sqliteTable(
  "enrolment_tokens",
  {
    enrolmentTokenId: text("enrolment_token_id").primaryKey(),
    tokenSha256: text("token_sha256").notNull(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    state: text("state").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
    }).onDelete("cascade"),
    index("enrolment_tokens_by_membership").on(table.tenantId, table.principalId),
    index("enrolment_tokens_by_tenant").on(table.tenantId, table.createdAt),
    unique().on(table.tokenSha256),
  ],
);

export const githubApps = sqliteTable("github_apps", {
  githubAppSlot: integer("github_app_slot").primaryKey(),
  appId: integer("app_id").notNull(),
  slug: text("slug").notNull(),
  clientId: text("client_id").notNull(),
  ownerLogin: text("owner_login").notNull(),
  htmlUrl: text("html_url").notNull(),
  wrappedDataKey: text("wrapped_data_key").notNull(),
  clientSecretSealed: text("client_secret_sealed").notNull(),
  webhookSecretSealed: text("webhook_secret_sealed").notNull(),
  privateKeySealed: text("private_key_sealed").notNull(),
  createdAt: integer("created_at").notNull(),
  botUserId: integer("bot_user_id"),
});

export const githubInstallations = sqliteTable(
  "github_installations",
  {
    installationId: integer("installation_id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references((): AnySQLiteColumn => tenants.tenantId),
    accountLogin: text("account_login").notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    accountType: text("account_type"),
  },
  (table) => [
    uniqueIndex("github_installations_by_account").on(table.accountLogin),
    index("github_installations_by_tenant").on(table.tenantId, table.createdAt),
  ],
);

export const githubInstallers = sqliteTable("github_installers", {
  installationId: integer("installation_id").primaryKey(),
  installerGithubUserId: integer("installer_github_user_id").notNull(),
});

export const hostChannelProtocols = sqliteTable("host_channel_protocols", {
  hostId: text("host_id")
    .primaryKey()
    .references((): AnySQLiteColumn => hosts.hostId, { onDelete: "cascade" }),
  channelProtocolOldest: integer("channel_protocol_oldest").notNull(),
  channelProtocolVersion: integer("channel_protocol_version").notNull(),
});

export const hostGuestProtocols = sqliteTable("host_guest_protocols", {
  hostId: text("host_id")
    .primaryKey()
    .references((): AnySQLiteColumn => hosts.hostId, { onDelete: "cascade" }),
  guestProtocolOldest: integer("guest_protocol_oldest").notNull(),
  guestProtocolVersion: integer("guest_protocol_version").notNull(),
});

export const hosts = sqliteTable(
  "hosts",
  {
    hostId: text("host_id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references((): AnySQLiteColumn => tenants.tenantId),
    name: text("name").notNull(),
    state: text("state").notNull(),
    architecture: text("architecture").notNull(),
    cpuCount: integer("cpu_count").notNull(),
    memoryBytes: integer("memory_bytes").notNull(),
    publicKey: text("public_key").notNull(),
    supervisorVersion: text("supervisor_version").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    labels: text("labels").notNull().default(sql`'[]'`),
    health: text("health").notNull().default(sql`'Healthy'`),
    reportedHealth: text("reported_health").notNull().default(sql`'Healthy'`),
  },
  (table) => [index("hosts_by_tenant").on(table.tenantId, table.createdAt)],
);

export const invitations = sqliteTable(
  "invitations",
  {
    invitationId: text("invitation_id").primaryKey(),
    tokenSha256: text("token_sha256").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references((): AnySQLiteColumn => tenants.tenantId),
    principalId: text("principal_id")
      .notNull()
      .references((): AnySQLiteColumn => principals.principalId),
    email: text("email").notNull(),
    role: text("role").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("invitations_by_tenant").on(table.tenantId, table.createdAt), unique().on(table.tokenSha256)],
);

export const issuerKeys = sqliteTable(
  "issuer_keys",
  {
    keySlot: integer("key_slot").primaryKey(),
    kid: text("kid").notNull(),
    publicJwk: text("public_jwk").notNull(),
    wrappedDataKey: text("wrapped_data_key").notNull(),
    privateKeySealed: text("private_key_sealed").notNull(),
  },
  (table) => [unique().on(table.kid)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references((): AnySQLiteColumn => tenants.tenantId),
    principalId: text("principal_id")
      .notNull()
      .references((): AnySQLiteColumn => principals.principalId),
    role: text("role").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.principalId] }),
    index("memberships_by_principal").on(table.principalId, table.createdAt),
  ],
);

export const oauthClients = sqliteTable("oauth_clients", {
  clientId: text("client_id").primaryKey(),
  clientName: text("client_name").notNull(),
  redirectUris: text("redirect_uris").notNull(),
  createdAt: integer("created_at").notNull(),
  firstParty: integer("first_party").notNull().default(sql`0`),
});

export const oauthCodes = sqliteTable(
  "oauth_codes",
  {
    codeSha256: text("code_sha256").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references((): AnySQLiteColumn => oauthClients.clientId, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    spent: integer("spent").notNull().default(sql`0`),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
    }).onDelete("cascade"),
    index("oauth_codes_by_membership").on(table.tenantId, table.principalId),
  ],
);

export const oauthRequests = sqliteTable("oauth_requests", {
  requestId: text("request_id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references((): AnySQLiteColumn => oauthClients.clientId, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  state: text("state").notNull(),
  stateSent: integer("state_sent").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  spent: integer("spent").notNull().default(sql`0`),
});

export const oauthTokens = sqliteTable(
  "oauth_tokens",
  {
    tokenSha256: text("token_sha256").primaryKey(),
    grantId: text("grant_id").notNull(),
    clientId: text("client_id")
      .notNull()
      .references((): AnySQLiteColumn => oauthClients.clientId, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    kind: text("kind").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    spent: integer("spent").notNull().default(sql`0`),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.principalId],
      foreignColumns: [memberships.tenantId, memberships.principalId],
    }).onDelete("cascade"),
    index("oauth_tokens_by_membership").on(table.tenantId, table.principalId),
    index("oauth_tokens_by_grant").on(table.grantId),
    index("oauth_tokens_by_client").on(table.clientId, table.expiresAt),
  ],
);

export const principals = sqliteTable(
  "principals",
  {
    principalId: text("principal_id").primaryKey(),
    email: text("email").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [unique().on(table.email)],
);

export const tenantLimits = sqliteTable("tenant_limits", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references((): AnySQLiteColumn => tenants.tenantId, { onDelete: "cascade" }),
  profile: text("profile").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const tenants = sqliteTable("tenants", {
  tenantId: text("tenant_id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  tier: text("tier").notNull().default(sql`'Configured'`),
});

export const triggerRouteConditions = sqliteTable(
  "trigger_route_conditions",
  {
    triggerId: text("trigger_id")
      .notNull()
      .references((): AnySQLiteColumn => triggerRoutes.triggerId, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    field: text("field").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.triggerId, table.position, table.value] })],
);

export const triggerRoutes = sqliteTable(
  "trigger_routes",
  {
    triggerId: text("trigger_id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references((): AnySQLiteColumn => tenants.tenantId),
    source: text("source").notNull(),
    event: text("event").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("trigger_routes_tenant_event").on(table.tenantId, table.source, table.event)],
);
