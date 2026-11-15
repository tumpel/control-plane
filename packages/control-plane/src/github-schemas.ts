import { GitHubAccountRoleSchema } from "@tumpel/api/schemas";
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

const EmailSchema = z.string().min(3).max(320);

export const GitHubInstallStateSchema = z.object({
  purpose: z.literal("Installation"),
  tenantId: TenantIdSchema,
  email: EmailSchema,
  expiresAt: OffsetDateTimeSchema,
  returnUrl: z.string().url().optional(),
  gitHubAccountId: GitHubIdSchema.optional(),
});

export const GitHubAccountsRefreshStateSchema = z.object({
  purpose: z.literal("AccountsRefresh"),
  tenantId: TenantIdSchema,
  email: EmailSchema,
  expiresAt: OffsetDateTimeSchema,
  returnUrl: z.string().url(),
});

export const GitHubInstallerIdentityStateSchema = z.object({
  purpose: z.literal("InstallerIdentity"),
  email: EmailSchema,
  installationId: GitHubIdSchema,
  expiresAt: OffsetDateTimeSchema,
});

export const GitHubInstallerIdentityCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const GitHubManifestCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const GitHubSetupActionSchema = z.object({
  setup_action: z.enum(["install", "update", "request"]),
  state: z.string().min(1).optional(),
});

export const GitHubSetupCallbackSchema = z.object({
  code: z.string().min(1),
  installation_id: z.string().regex(/^[1-9][0-9]{0,15}$/),
  setup_action: z.enum(["install", "update"]),
  state: z.string().min(1).optional(),
});

export const GitHubInstallationChoiceQuerySchema = z.object({
  choice: z.string().min(1),
  tenant: TenantIdSchema,
});

const GitHubAppPermissionsSchema = z.object({
  actions: z.literal("write"),
  administration: z.literal("write"),
  artifact_metadata: z.literal("write"),
  attestations: z.literal("write"),
  checks: z.literal("write"),
  code_quality: z.literal("read"),
  security_events: z.literal("write"),
  statuses: z.literal("write"),
  contents: z.literal("write"),
  repository_custom_properties: z.literal("write"),
  vulnerability_alerts: z.literal("write"),
  dependabot_secrets: z.literal("write"),
  deployments: z.literal("write"),
  discussions: z.literal("write"),
  environments: z.literal("write"),
  issues: z.literal("write"),
  merge_queues: z.literal("write"),
  metadata: z.literal("read"),
  packages: z.literal("write"),
  pages: z.literal("write"),
  repository_projects: z.literal("write"),
  pull_requests: z.literal("write"),
  secret_scanning_alerts: z.literal("write"),
  secrets: z.literal("write"),
  actions_variables: z.literal("write"),
  repository_hooks: z.literal("write"),
  workflows: z.literal("write"),
  members: z.literal("read"),
  organization_projects: z.literal("write"),
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
  public: z.literal(true),
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
  account: z.object({ id: GitHubIdSchema, login: GitHubLoginSchema, type: z.enum(["User", "Organization"]) }),
});

export const GitHubInstallationChoiceStateSchema = z.object({
  purpose: z.literal("InstallationChoice"),
  email: z.string().min(3).max(320),
  installation: GitHubInstallationRecordSchema,
  expiresAt: OffsetDateTimeSchema,
});

export const GitHubBotUserSchema = z.object({
  id: GitHubIdSchema,
});

export const GitHubUserSchema = z.object({
  id: GitHubIdSchema,
  login: GitHubLoginSchema,
});

export const GitHubUserInstallationsSchema = z.object({
  installations: z.array(z.object({ id: GitHubIdSchema }).loose()),
});

export const GitHubReachableInstallationsSchema = z.object({
  installations: z.array(GitHubInstallationRecordSchema),
});

export const GitHubOrganizationMembershipsSchema = z.array(
  z.object({
    role: z.string(),
    organization: z.object({ id: GitHubIdSchema, login: GitHubLoginSchema }),
  }),
);

export const GitHubReadingSchema = z.object({
  user: z.object({ githubUserId: GitHubIdSchema, login: GitHubLoginSchema }),
  organizations: z.array(
    z.object({ gitHubAccountId: GitHubIdSchema, login: GitHubLoginSchema, role: GitHubAccountRoleSchema }),
  ),
  installations: z.array(GitHubInstallationRecordSchema),
});

export const GitHubInstallationTokenSchema = z.object({
  token: z.string(),
  expires_at: OffsetDateTimeSchema,
  permissions: z.record(z.string(), z.string()),
});

export const GitHubFileSchema = z.object({
  sha: z.string().min(1),
  encoding: z.literal("base64"),
  content: z.string(),
});

export const GitHubFileCommitSchema = z.object({
  commit: z.object({ sha: z.string().min(1) }),
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
  sender: z.object({ id: GitHubIdSchema }),
});

export const GitHubInstallationRepositoriesSchema = z.object({
  total_count: z.int().min(0),
  repositories: z.array(
    z.object({
      name: z.string(),
      owner: GitHubAccountSchema,
      default_branch: z.string(),
      private: z.boolean(),
      html_url: z.string().url(),
    }),
  ),
});

export const GitHubIssueRecordSchema = z.object({
  number: z.int().min(1),
  title: z.string(),
  html_url: z.string().url(),
  body: z.string().nullable(),
  state: z.string(),
  updated_at: OffsetDateTimeSchema,
  labels: z.array(z.object({ name: z.string() })),
  pull_request: z.object({}).loose().optional(),
});

export const GitHubIssueRecordsSchema = z.array(GitHubIssueRecordSchema);

export const GitHubCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  commit: z.object({ tree: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }) }),
});

export const GitHubWorkflowRunEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: GitHubIdSchema }),
  repository: z.object({ full_name: z.string() }),
  workflow_run: z.object({
    id: GitHubIdSchema,
    path: z.string(),
    head_sha: z.string(),
    html_url: z.string().url(),
    conclusion: z.string().nullable(),
  }),
});
