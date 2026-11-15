import { z } from "zod";

const GitHubIdSchema = z.int().min(1);
const GitHubLoginSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);
const OffsetDateTimeSchema = z.string().datetime({ offset: true });
const TenantIdSchema = z.string().min(1).max(64);

export const GitHubManifestStateSchema = z.object({
  purpose: z.literal("AppManifest"),
  email: z.string().min(3).max(320),
  expiresAt: OffsetDateTimeSchema,
});

export const GitHubInstallStateSchema = z.object({
  purpose: z.literal("Installation"),
  tenantId: TenantIdSchema,
  expiresAt: OffsetDateTimeSchema,
});

export const GitHubManifestCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const GitHubSetupActionSchema = z.object({
  setup_action: z.enum(["install", "update", "request"]),
});

export const GitHubSetupCallbackSchema = z.object({
  code: z.string().min(1),
  installation_id: z.string().regex(/^[1-9][0-9]{0,15}$/),
  setup_action: z.enum(["install", "update"]),
  state: z.string().min(1),
});

const GitHubAppPermissionsSchema = z.object({
  contents: z.literal("write"),
  pull_requests: z.literal("write"),
  issues: z.literal("write"),
  metadata: z.literal("read"),
  checks: z.literal("write"),
  statuses: z.literal("write"),
  workflows: z.literal("write"),
  discussions: z.literal("write"),
  actions: z.literal("read"),
});

export const GitHubAppManifestSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  description: z.string(),
  hook_attributes: z.object({ url: z.string().url(), active: z.literal(true) }),
  redirect_url: z.string().url(),
  callback_urls: z.array(z.string().url()),
  setup_url: z.string().url(),
  setup_on_update: z.literal(true),
  public: z.literal(false),
  request_oauth_on_install: z.literal(true),
  default_permissions: GitHubAppPermissionsSchema,
  default_events: z.array(z.string()),
});

const GitHubAccountSchema = z.object({ login: GitHubLoginSchema });

export const GitHubAppConversionSchema = z.object({
  id: GitHubIdSchema,
  slug: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
  webhook_secret: z.string(),
  pem: z.string(),
  owner: GitHubAccountSchema,
  html_url: z.string().url(),
});

export const GitHubInstallationRecordSchema = z.object({
  id: GitHubIdSchema,
  account: GitHubAccountSchema,
});

export const GitHubUserInstallationsSchema = z.object({
  installations: z.array(GitHubInstallationRecordSchema),
});

export const GitHubInstallationTokenSchema = z.object({
  token: z.string(),
  expires_at: OffsetDateTimeSchema,
});

export const GitHubUserTokenSchema = z.union([
  z.object({ access_token: z.string().min(1) }),
  z.object({ error: z.string(), error_description: z.string() }),
]);

export const GitHubErrorSchema = z.object({
  message: z.string(),
});

export const GitHubInstallationEventSchema = z.object({
  action: z.string(),
  installation: GitHubInstallationRecordSchema,
});
