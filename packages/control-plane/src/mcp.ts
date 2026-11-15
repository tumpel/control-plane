import {
  ApiKeyMemberSchema,
  CircleCIConnectionStartSchema,
  CircleCIProjectAddSchema,
  CircleCIProjectPathSchema,
  ClaudeSetupPathSchema,
  ClaudeSetupStartSchema,
  ConfigApiKeySchema,
  ConfigSecretSetSchema,
  ConfigSecretValueSchema,
  ConfigSecretVariableSchema,
  ConfigSubscriptionTokenSchema,
  DevicePathSchema,
  EnrolmentTokenMintSchema,
  EnrolmentTokenPathSchema,
  GitHubActionsConnectionStartSchema,
  GitHubInstallationPathSchema,
  GitHubRepositoryPathSchema,
  HarnessPathSchema,
  HarnessPinCreateSchema,
  HostLabelsSchema,
  HostPathSchema,
  InvitationCreateSchema,
  InvitationPathSchema,
  MemberPathSchema,
  NamespaceConnectionStartSchema,
  OAuthGrantPathSchema,
  PersonaCreateSchema,
  PersonaFileUploadRequestSchema,
  PersonaPathSchema,
  PersonaUpdateSchema,
  PrebuildListQuerySchema,
  PrebuildPathSchema,
  PrebuildStartSchema,
  ProblemSchema,
  SecretMemberPathSchema,
  SecretSetPathSchema,
  SecretVariableMemberSchema,
  SessionListQuerySchema,
  SessionPathSchema,
  SessionStartFromIssueSchema,
  SessionStartSchema,
  SnapshotPathSchema,
  SubscriptionTokenMemberSchema,
  TenantConfigApplySchema,
  TenantConfigPlanRequestSchema,
  TranscriptQuerySchema,
  TurnPathSchema,
  TurnSendSchema,
} from "@tumpel/api/schemas";
import { z } from "zod";
import manifest from "../package.json";
import { issues, type Problem } from "./http";
import { MCP_PATH } from "./oauth";

const MODERN_VERSION = "2026-07-28";
const LATEST_LEGACY = "2025-11-25";
const LEGACY_VERSIONS = [LATEST_LEGACY, "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/;

const SERVER_INFO = { name: "tumpel", version: manifest.version };

const INSTRUCTIONS =
  "tumpel runs coding harness sessions on machines the user's tenant owns. Every tool calls the tumpel REST API as the signed-in principal: tumpel_whoami names the tenant, tumpel_tenants lists every tenant you belong to, tumpel_member_* and tumpel_invitation_* list, invite and remove the people of the tenant, tumpel_host_* add, label and retire machines and their enrolment tokens, tumpel_persona_* and tumpel_harness_* shape what runs, and tumpel_secret_set_* read key names, remove a member and draft config entries and set-member commands, since secret values never pass through MCP: they arrive through the dashboard, the OAuth connections, tumpel config apply or tumpel secret-set set-member --stdin on the CLI. tumpel_devices_* list and sign out your devices. tumpel_github_start answers the URL that connects one more GitHub account or organization through the GitHub App, tumpel_github_list lists the connected ones, tumpel_github_delete removes one, and tumpel_github_get reads the App, and tumpel_release_current reads the supervisor and guest images hosts run, tumpel_connection_list lists every connection with its state, tumpel_oauth_grant_list lists the clients signed in as you and tumpel_oauth_grant_revoke signs one out, tumpel_config_plan and tumpel_config_apply make the tenant match a tenant config, tumpel_github_actions_*, tumpel_circleci_* and tumpel_namespace_* connect the tenant's own build provider accounts, with CircleCI API tokens kept off MCP, and tumpel_prebuild_* start and read the prebuilds that install a repository's dependencies ahead of its sessions. tumpel_claude_setup_start mints a Claude subscription token into a secret set from a short-lived box and tumpel_claude_setup_get reads its sign-in URL and outcome; the person pastes the sign-in code into the dashboard or tumpel claude-setup submit-code, never through MCP. tumpel_session_start runs a session on an online host, tumpel_github_list_repositories and tumpel_github_list_issues find an issue and tumpel_session_start_from_issue starts a session that works it into a draft pull request, tumpel_turn_send sends its next prompt, tumpel_session_stop frees its box, tumpel_session_archive deletes its snapshots, and tumpel_transcript_read reads what the harness wrote, page by page: pass the cursor of the last page as after, and compact true to poll a live turn without tool output.";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;
const UNAUTHORIZED = -32001;

export type ToolResult = { ok: true; text: string } | { ok: false; error: string };

export type Dispatch = (request: Request) => Promise<Response>;

export type Authorize = () => Promise<Dispatch | Response>;

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface ToolDefinition {
  name: string;
  description: string;
  input: z.ZodObject;
  request: { method: Method; path: string } | null;
  answer: "rest" | "configSecretSet" | "memberCommand" | "circleCIStartCommand";
}

const NO_ARGUMENTS = z.object({});

const KEY_NAMES_ONLY = ConfigSecretSetSchema.extend({
  secrets: z.array(
    z.discriminatedUnion("kind", [
      ConfigSecretVariableSchema.strict(),
      ConfigApiKeySchema.strict(),
      ConfigSubscriptionTokenSchema.strict(),
    ]),
  ),
}).strict();

const KEY_NAMES_RULE =
  "Secret values never pass through MCP; they arrive through the dashboard, the OAuth connections, tumpel config apply or tumpel secret-set set-member --stdin on the CLI. This tool writes nothing: each member names its kind (Variable, ApiKey, or SubscriptionToken with its expiresAt), a provider for a credential, and only the environment variable (valueFrom.env) its value is read from, which the server cannot resolve. Returns the ConfigSecretSet entry to put in secretSets of the tenant config file; export each named variable on your machine and run tumpel config apply <file>, which writes the values.";

const MEMBER_WITHOUT_VALUE = SecretSetPathSchema.extend({
  member: z.discriminatedUnion("kind", [
    SecretVariableMemberSchema.strict(),
    ApiKeyMemberSchema.strict(),
    SubscriptionTokenMemberSchema.strict(),
  ]),
}).strict();

const memberCommand = (args: z.infer<typeof MEMBER_WITHOUT_VALUE>): string => {
  const { member } = args;
  const kind = member.kind.replace(/\B([A-Z])/g, "-$1").toLowerCase();
  const flags = [`--name ${member.name}`];
  if (member.kind !== "Variable") flags.push(`--provider ${member.provider}`);
  if (member.kind === "SubscriptionToken") flags.push(`--expires-at ${member.expiresAt}`);
  return `Secret values never pass through MCP and this tool writes nothing. Pipe the value of ${member.name} into this command on your machine: tumpel secret-set set-member ${kind} ${args.secretSetId} ${flags.join(" ")} --stdin`;
};

const CIRCLECI_START_WITHOUT_TOKEN = CircleCIConnectionStartSchema.omit({ apiToken: true }).strict();

const shellQuoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const circleCIStartCommand = (args: z.infer<typeof CIRCLECI_START_WITHOUT_TOKEN>): string =>
  `CircleCI API tokens never pass through MCP and this tool writes nothing. Pipe a personal API token of a member of the organization into this command on your machine: tumpel circleci start --account-label ${shellQuoted(args.accountLabel)} --organization-id ${args.organizationId} --token-stdin. Or paste it in the dashboard's Connect CircleCI dialog.`;

const NO_SECRET_VALUES = TenantConfigApplySchema.extend({
  secretValues: z
    .array(ConfigSecretValueSchema.pick({ env: true }).strict())
    .max(
      0,
      "secret values never pass through MCP; they arrive through the dashboard, the OAuth connections, tumpel config apply or tumpel secret-set set-member --stdin on the CLI",
    ),
});

const rest = (name: string, method: Method, path: string, input: z.ZodObject, description: string): ToolDefinition => ({
  name,
  description,
  input,
  request: { method, path },
  answer: "rest",
});

export const TOOLS: ToolDefinition[] = [
  rest(
    "tumpel_whoami",
    "GET",
    "/v1/whoami",
    NO_ARGUMENTS,
    "Name the tenant and principal this connector acts as. Returns the Whoami of GET /v1/whoami: {tenant, principal}.",
  ),
  rest(
    "tumpel_devices_list",
    "GET",
    "/v1/devices",
    NO_ARGUMENTS,
    "List the devices signed in as you. Returns the Device[] of GET /v1/devices.",
  ),
  rest(
    "tumpel_devices_revoke",
    "DELETE",
    "/v1/devices/{deviceId}",
    DevicePathSchema,
    "Sign a device out; its token stops working at once. Calls DELETE /v1/devices/{deviceId}.",
  ),
  rest(
    "tumpel_tenants",
    "GET",
    "/v1/whoami/tenants",
    NO_ARGUMENTS,
    "List every tenant you belong to, with your role there. Returns the Membership[] of GET /v1/whoami/tenants: {tenant, role, createdAt}. This connector acts in one of them; to act in another, connect again and choose it on the consent page.",
  ),
  rest(
    "tumpel_member_list",
    "GET",
    "/v1/members",
    NO_ARGUMENTS,
    "List the people of the tenant. Returns the Principal[] of GET /v1/members: principalId, tenantId, email and role (Owner or Member).",
  ),
  rest(
    "tumpel_member_remove",
    "DELETE",
    "/v1/members/{principalId}",
    MemberPathSchema,
    "Remove a person from the tenant and sign out their devices and tokens there. Owner only; refused LastOwner for the tenant's last Owner. Calls DELETE /v1/members/{principalId}.",
  ),
  rest(
    "tumpel_invitation_create",
    "POST",
    "/v1/invitations",
    InvitationCreateSchema,
    "Invite an email to the tenant as Owner or Member for seven days. Owner only. Returns the InvitationCreated of POST /v1/invitations: {invitation, acceptUrl}. No email is sent: give acceptUrl to the invitee, who opens it signed in to Cloudflare Access as that email. acceptUrl is shown only now.",
  ),
  rest(
    "tumpel_invitation_list",
    "GET",
    "/v1/invitations",
    NO_ARGUMENTS,
    "List the tenant's open invitations. Returns the Invitation[] of GET /v1/invitations.",
  ),
  rest(
    "tumpel_invitation_revoke",
    "DELETE",
    "/v1/invitations/{invitationId}",
    InvitationPathSchema,
    "Revoke an open invitation; its link stops working. Owner only. Calls DELETE /v1/invitations/{invitationId}.",
  ),
  rest(
    "tumpel_host_mint_token",
    "POST",
    "/v1/enrolment-tokens",
    EnrolmentTokenMintSchema,
    "Mint a one-time enrolment token for a new host; expiresInSeconds is how long the token enrols a host. Returns the MintedEnrolmentToken of POST /v1/enrolment-tokens: {enrolmentToken, token, installCommand}. The token is shown once. installCommand holds no token and reads it from stdin: run installCommand on the new x86_64 host with the token on stdin; it downloads the supervisor, installs it and enrols the host.",
  ),
  rest(
    "tumpel_host_list_tokens",
    "GET",
    "/v1/enrolment-tokens",
    NO_ARGUMENTS,
    "List the tenant's unused, unexpired enrolment tokens, without their token values. Returns the EnrolmentToken[] of GET /v1/enrolment-tokens: enrolmentTokenId, principalId, expiresAt and createdAt.",
  ),
  rest(
    "tumpel_host_revoke_token",
    "DELETE",
    "/v1/enrolment-tokens/{enrolmentTokenId}",
    EnrolmentTokenPathSchema,
    "Revoke an unused enrolment token; no host can enrol with it. Calls DELETE /v1/enrolment-tokens/{enrolmentTokenId}.",
  ),
  rest(
    "tumpel_host_list",
    "GET",
    "/v1/hosts",
    NO_ARGUMENTS,
    "List the tenant's hosts with their presence. Returns the Host[] of GET /v1/hosts; state is Enrolled, Online, Offline or Revoked.",
  ),
  rest(
    "tumpel_host_list_usage",
    "GET",
    "/v1/hosts/usage",
    NO_ARGUMENTS,
    "List the box slots and last reported usage of each host of the tenant that has connected since it enrolled and is not revoked. Returns the ReportedHostUsage[] of GET /v1/hosts/usage: hostId, boxCapacity, boxesRunning (the tenant's Offered and Running turns on the host), boxesWarm, loadAverage, memoryAvailableMib and updatedAt, when the last Hello or Heartbeat arrived.",
  ),
  rest(
    "tumpel_host_get",
    "GET",
    "/v1/hosts/{hostId}",
    HostPathSchema,
    "Read one host with its presence and labels. Returns the Host of GET /v1/hosts/{hostId}.",
  ),
  rest(
    "tumpel_host_revoke",
    "POST",
    "/v1/hosts/{hostId}/revoke",
    HostPathSchema,
    "Revoke a host: its channel closes and it cannot connect again. Returns the Host of POST /v1/hosts/{hostId}/revoke.",
  ),
  rest(
    "tumpel_host_set_labels",
    "PUT",
    "/v1/hosts/{hostId}/labels",
    HostPathSchema.extend(HostLabelsSchema.shape),
    "Replace every label of a host. Returns the Host of PUT /v1/hosts/{hostId}/labels.",
  ),
  rest(
    "tumpel_harness_list",
    "GET",
    "/v1/harnesses",
    NO_ARGUMENTS,
    "List the harness catalog: every harness and version a tenant can pin. Returns the HarnessCatalogEntry[] of GET /v1/harnesses.",
  ),
  rest(
    "tumpel_harness_list_pins",
    "GET",
    "/v1/harnesses/pins",
    NO_ARGUMENTS,
    "List every harness of the catalog with the version new sessions of it run and whether the tenant pins it. Returns the EffectiveHarnessVersion[] of GET /v1/harnesses/pins.",
  ),
  rest(
    "tumpel_harness_pin",
    "PUT",
    "/v1/harnesses/pins",
    HarnessPinCreateSchema,
    "Pin a harness to a version of the catalog, replacing its pin. Returns the HarnessPin of PUT /v1/harnesses/pins.",
  ),
  rest(
    "tumpel_harness_unpin",
    "DELETE",
    "/v1/harnesses/pins/{harness}",
    HarnessPathSchema,
    "Remove the tenant's pin for a harness. Calls DELETE /v1/harnesses/pins/{harness}.",
  ),
  rest(
    "tumpel_release_current",
    "GET",
    "/v1/releases/current",
    NO_ARGUMENTS,
    "Read the current release: releaseVersion, commit, channelProtocolVersion, the supervisor binary of each architecture and the guest image of each harness version and architecture. Returns the ReleaseManifest of GET /v1/releases/current; a session is placed only on a host whose architecture has an image of its harness version here.",
  ),
  rest(
    "tumpel_persona_create",
    "POST",
    "/v1/personas",
    PersonaCreateSchema,
    "Create a persona: the harness its sessions run, the secretSetId of the secret set they run on, and the harness's own config files at paths the harness catalog accepts, each Inline (base64 content, up to PersonaFileLimit.InlineFileBytes) or Stored (digest and sizeBytes of an uploaded file). Returns the Persona of POST /v1/personas.",
  ),
  rest(
    "tumpel_persona_upload_file",
    "POST",
    "/v1/personas/file-uploads",
    PersonaFileUploadRequestSchema,
    "Presign the upload of one persona file larger than PersonaFileLimit.InlineFileBytes, named by the sha256 digest and size of its bytes. Returns the PersonaFileUpload of POST /v1/personas/file-uploads: PUT the bytes to uploadUrl before uploadExpiresAt, then name the file as Stored by digest in a persona write.",
  ),
  rest(
    "tumpel_persona_list",
    "GET",
    "/v1/personas",
    NO_ARGUMENTS,
    "List the tenant's personas. Returns the Persona[] of GET /v1/personas.",
  ),
  rest(
    "tumpel_persona_get",
    "GET",
    "/v1/personas/{personaId}",
    PersonaPathSchema,
    "Read one persona. Returns the Persona of GET /v1/personas/{personaId}.",
  ),
  rest(
    "tumpel_persona_update",
    "PUT",
    "/v1/personas/{personaId}",
    PersonaPathSchema.extend(PersonaUpdateSchema.shape),
    "Replace a persona's name, secret set, git identity and whole file set; its harness is fixed at create and a file left out is deleted. Name an unchanged file as Stored by its digest and sizeBytes. Returns the Persona of PUT /v1/personas/{personaId}.",
  ),
  rest(
    "tumpel_persona_delete",
    "DELETE",
    "/v1/personas/{personaId}",
    PersonaPathSchema,
    "Delete a persona no session ran on; one that sessions ran on is refused. Calls DELETE /v1/personas/{personaId}.",
  ),
  {
    name: "tumpel_secret_set_create",
    description: `Draft a new secret set of variables and provider credentials, by member name. ${KEY_NAMES_RULE}`,
    input: KEY_NAMES_ONLY,
    request: null,
    answer: "configSecretSet",
  },
  rest(
    "tumpel_github_get",
    "GET",
    "/v1/github-connection",
    NO_ARGUMENTS,
    "Read the stage's GitHub App as the tenant sees it. Returns the GitHubConnection of GET /v1/github-connection: app.state is Ready with the appSlug, or AppMissing with the setupUrl where a person creates the stage's GitHub App once. tumpel_github_list lists the tenant's installations.",
  ),
  rest(
    "tumpel_github_list",
    "GET",
    "/v1/github-connection/installations",
    NO_ARGUMENTS,
    "List every GitHub account or organization the tenant connected, one installation of the stage's GitHub App each. Returns the GitHubInstallation[] of GET /v1/github-connection/installations: installationId, accountLogin, status (Active or Suspended), createdAt and updatedAt.",
  ),
  rest(
    "tumpel_github_start",
    "POST",
    "/v1/github-connection/start",
    NO_ARGUMENTS,
    "Get the URL where a person installs the stage's GitHub App on one more account or organization for the tenant; installations already connected stay. Returns the GitHubInstallStart of POST /v1/github-connection/start: {installUrl, expiresAt}. Hand installUrl to the user to open in a browser before expiresAt; afterwards every turn on a repository of that account gets a short-lived installation token as GITHUB_TOKEN and GH_TOKEN.",
  ),
  rest(
    "tumpel_github_delete",
    "DELETE",
    "/v1/github-connection/installations/{installationId}",
    GitHubInstallationPathSchema,
    "Remove one GitHub installation from the tenant, by the installationId tumpel_github_list prints; turns on repositories of its account then use the secret set's GITHUB_TOKEN. Calls DELETE /v1/github-connection/installations/{installationId}. The installation stays on GitHub until a person uninstalls the App there.",
  ),
  rest(
    "tumpel_github_list_repositories",
    "GET",
    "/v1/github-connection/repositories",
    NO_ARGUMENTS,
    "List the repositories every GitHub installation of the tenant covers. Returns the GitHubRepository[] of GET /v1/github-connection/repositories: owner, name, defaultBranch, private and htmlUrl; refused GitHubNotConnected until the App is installed with tumpel_github_start.",
  ),
  rest(
    "tumpel_github_list_issues",
    "GET",
    "/v1/github-connection/repositories/{owner}/{name}/issues",
    GitHubRepositoryPathSchema,
    "List the open issues of a repository an installation of the tenant covers, most recently updated first, without pull requests. Returns the GitHubIssue[] of GET /v1/github-connection/repositories/{owner}/{name}/issues: issueNumber, title, htmlUrl, labels and updatedAt.",
  ),
  rest(
    "tumpel_oauth_grant_list",
    "GET",
    "/v1/oauth-grants",
    NO_ARGUMENTS,
    "List the OAuth clients, such as this connector or the dashboard, that hold a live token for you in this tenant. Returns the OAuthGrant[] of GET /v1/oauth-grants: grantId, clientId, clientName, redirectOrigin and lastIssuedAt.",
  ),
  rest(
    "tumpel_oauth_grant_revoke",
    "DELETE",
    "/v1/oauth-grants/{grantId}",
    OAuthGrantPathSchema,
    "Revoke one of your OAuth grants: every access and refresh token of the grant stops working at once, so revoking this connector's own grant signs it out. Calls DELETE /v1/oauth-grants/{grantId}.",
  ),
  rest(
    "tumpel_config_plan",
    "POST",
    "/v1/tenant-config/plan",
    TenantConfigPlanRequestSchema,
    "Plan the changes that make the tenant match a TenantConfig, and change nothing. Send the config, the sha256 digest and sizeBytes of each persona file by its from path, the expiresAt of each expiry variable, and in secretValues the names of the variables apply will send, never their values; an empty list keeps every kept secret set as it is. A persona, secret set or pin the config leaves out is deleted. Returns the ConfigPlan of POST /v1/tenant-config/plan: each change with its action, resource, name and description.",
  ),
  rest(
    "tumpel_config_apply",
    "POST",
    "/v1/tenant-config/apply",
    NO_SECRET_VALUES,
    "Apply a TenantConfig: the plan of tumpel_config_plan, made in order. Secret values never pass through MCP, so secretValues must be empty: a secret set the config keeps keeps its values, and a config that creates or updates a secret set is refused for the missing values, which arrive through the dashboard, the OAuth connections or tumpel config apply on the CLI. Send each persona file Inline (base64 content) or Stored by digest. Returns the ConfigPlan of POST /v1/tenant-config/apply.",
  ),
  rest(
    "tumpel_connection_list",
    "GET",
    "/v1/connections",
    NO_ARGUMENTS,
    "List one row per connection kind: GitHub, GitHubActions, CircleCI and Namespace, each NotConfigured, NotConnected or Connected with the account it bills. Returns the ConnectionSummary[] of GET /v1/connections.",
  ),
  rest(
    "tumpel_github_actions_get",
    "GET",
    "/v1/github-actions-connection",
    NO_ARGUMENTS,
    "Read the tenant's GitHub Actions build provider connection. Returns the GitHubActionsConnectionLink of GET /v1/github-actions-connection.",
  ),
  rest(
    "tumpel_github_actions_start",
    "POST",
    "/v1/github-actions-connection/start",
    GitHubActionsConnectionStartSchema,
    "Connect the tenant's own GitHub Actions account, replacing an earlier one. Takes {accountLabel, callerWorkflow}: callerWorkflow is the workflow file each repository holds, such as .github/workflows/tumpel-prebuild.yml, which calls Tumpel's reusable prebuild workflow. Returns the GitHubActionsConnectionLink of POST /v1/github-actions-connection/start.",
  ),
  rest(
    "tumpel_github_actions_delete",
    "DELETE",
    "/v1/github-actions-connection",
    NO_ARGUMENTS,
    "Disconnect the tenant's GitHub Actions account. Calls DELETE /v1/github-actions-connection.",
  ),
  rest(
    "tumpel_namespace_get",
    "GET",
    "/v1/namespace-connection",
    NO_ARGUMENTS,
    "Read the tenant's Namespace build provider connection. Returns the NamespaceConnectionLink of GET /v1/namespace-connection: the issuer, subject pattern and audience to register at Namespace.",
  ),
  rest(
    "tumpel_namespace_start",
    "POST",
    "/v1/namespace-connection/start",
    NamespaceConnectionStartSchema,
    "Connect the tenant's own Namespace workspace, replacing an earlier one. Takes {accountLabel, workspaceId}: workspaceId is the Namespace workspace id, such as tenant_123456789ab, that the builds run in; register the issuer, subject pattern and audience tumpel_namespace_get answers at Namespace first. Returns the NamespaceConnectionLink of POST /v1/namespace-connection/start.",
  ),
  rest(
    "tumpel_namespace_delete",
    "DELETE",
    "/v1/namespace-connection",
    NO_ARGUMENTS,
    "Disconnect the tenant's Namespace workspace. Calls DELETE /v1/namespace-connection.",
  ),
  rest(
    "tumpel_circleci_get",
    "GET",
    "/v1/circleci-connection",
    NO_ARGUMENTS,
    "Read the tenant's CircleCI build provider connection. Returns the CircleCIConnectionLink of GET /v1/circleci-connection: the connection without its token, the orb and the config each repository commits.",
  ),
  {
    name: "tumpel_circleci_start",
    description:
      "Draft the command that connects the tenant's CircleCI organization. Takes {accountLabel, organizationId}: organizationId is the organization id from CircleCI's Organization Settings. CircleCI API tokens never pass through MCP, so this tool writes nothing; it returns the tumpel circleci start command the user pipes a personal API token into.",
    input: CIRCLECI_START_WITHOUT_TOKEN,
    request: null,
    answer: "circleCIStartCommand",
  },
  rest(
    "tumpel_circleci_delete",
    "DELETE",
    "/v1/circleci-connection",
    NO_ARGUMENTS,
    "Disconnect the tenant's CircleCI organization and delete its project bindings. Calls DELETE /v1/circleci-connection.",
  ),
  rest(
    "tumpel_circleci_project_list",
    "GET",
    "/v1/circleci-projects",
    NO_ARGUMENTS,
    "List the repositories bound to a CircleCI project. Returns the CircleCIProject[] of GET /v1/circleci-projects.",
  ),
  rest(
    "tumpel_circleci_project_add",
    "POST",
    "/v1/circleci-projects",
    CircleCIProjectAddSchema,
    "Bind a repository to its CircleCI project once. Takes {repository, projectSlug, pipelineDefinitionId}: projectSlug is gh/<owner>/<name> in a GitHub OAuth organization or circleci/<organization id>/<project id> in a GitHub App organization, and the pipeline definition must check out the repository. Returns the CircleCIProject of POST /v1/circleci-projects.",
  ),
  rest(
    "tumpel_circleci_project_delete",
    "DELETE",
    "/v1/circleci-projects/{circleCIProjectId}",
    CircleCIProjectPathSchema,
    "Delete a repository's CircleCI project binding. Calls DELETE /v1/circleci-projects/{circleCIProjectId}.",
  ),
  rest(
    "tumpel_prebuild_start",
    "POST",
    "/v1/prebuilds",
    PrebuildStartSchema,
    "Start a prebuild of a repository's default branch on the named build provider, GitHubActions, CircleCI or Namespace; personaId names the persona whose secret set's GITHUB_TOKEN reads the repository when the GitHub App installation does not cover it, and whose harness version picks the guest image. Returns the Prebuild of POST /v1/prebuilds; a stored or running prebuild with the same key comes back unless rebuild is true. Refused NoBuildProvider when the named provider is not connected, and BuildProviderUnavailable while this control plane cannot dispatch to it.",
  ),
  rest(
    "tumpel_prebuild_list",
    "GET",
    "/v1/prebuilds",
    PrebuildListQuerySchema,
    "List the prebuilds of one repository, newest first. Returns the Prebuild[] of GET /v1/prebuilds?repository=.",
  ),
  rest(
    "tumpel_prebuild_list_latest",
    "GET",
    "/v1/prebuilds/latest",
    NO_ARGUMENTS,
    "List the newest prebuild of each repository the tenant has prebuilt, ordered by repository. Returns the Prebuild[] of GET /v1/prebuilds/latest.",
  ),
  rest(
    "tumpel_claude_setup_start",
    "POST",
    "/v1/claude-setups",
    ClaudeSetupStartSchema,
    "Mint a Claude subscription token for a secret set without installing Claude Code: starts a short-lived box on an Online host that runs claude setup-token from the pinned Claude Code, with no secret set member and no GitHub token. Returns the ClaudeSetup of POST /v1/claude-setups in state Starting; poll tumpel_claude_setup_get until it is AwaitingCode, give the person its signInUrl, and have them paste the code the sign-in page shows into the dashboard or tumpel claude-setup submit-code --stdin, since the code never passes through MCP. Refused NoHostOnline when no Online host can run the box.",
  ),
  rest(
    "tumpel_claude_setup_get",
    "GET",
    "/v1/claude-setups/{claudeSetupId}",
    ClaudeSetupPathSchema,
    "Read one Claude setup. Returns the ClaudeSetup of GET /v1/claude-setups/{claudeSetupId}; status.state is Starting, AwaitingCode with signInUrl and codeDueAt, Minting, Completed with the member CLAUDE_CODE_OAUTH_TOKEN and its expiresAt, or Failed with reason SetupUrlMissing, CodeRejected, SetupTimedOut, TokenNotStored or NoHostOnline and a detail naming the fix. It never carries the token.",
  ),
  rest(
    "tumpel_prebuild_get",
    "GET",
    "/v1/prebuilds/{prebuildId}",
    PrebuildPathSchema,
    "Read one prebuild. Returns the Prebuild of GET /v1/prebuilds/{prebuildId}; status.state is Dispatched, Building, Converting, Done with the layer, or Failed with the phase.",
  ),
  rest(
    "tumpel_prebuild_failure",
    "GET",
    "/v1/prebuilds/{prebuildId}/failure",
    PrebuildPathSchema,
    "Read why a Failed prebuild failed. Returns the PrebuildFailure of GET /v1/prebuilds/{prebuildId}/failure: {phase, detail, fix}.",
  ),
  rest(
    "tumpel_secret_set_list",
    "GET",
    "/v1/secret-sets",
    NO_ARGUMENTS,
    "List the tenant's secret sets with their member names and kinds; values are write-only and never returned. Returns the SecretSet[] of GET /v1/secret-sets.",
  ),
  rest(
    "tumpel_secret_set_get",
    "GET",
    "/v1/secret-sets/{secretSetId}",
    SecretSetPathSchema,
    "Read one secret set with its member names and kinds; values are write-only and never returned. Returns the SecretSet of GET /v1/secret-sets/{secretSetId}.",
  ),
  {
    name: "tumpel_secret_set_update",
    description: `Draft the replacement of an existing secret set's name and members, by member name; the set must exist. ${KEY_NAMES_RULE}`,
    input: SecretSetPathSchema.extend(KEY_NAMES_ONLY.shape).strict(),
    request: { method: "GET", path: "/v1/secret-sets/{secretSetId}" },
    answer: "configSecretSet",
  },
  {
    name: "tumpel_secret_set_set_member",
    description:
      "Draft the write of one member of an existing secret set, by its kind, name, provider and expiresAt; the set must exist. Secret values never pass through MCP and this tool writes nothing. Returns the tumpel secret-set set-member command that reads the value on stdin and writes it, keeping every other member.",
    input: MEMBER_WITHOUT_VALUE,
    request: { method: "GET", path: "/v1/secret-sets/{secretSetId}" },
    answer: "memberCommand",
  },
  rest(
    "tumpel_secret_set_remove_member",
    "DELETE",
    "/v1/secret-sets/{secretSetId}/members/{name}",
    SecretMemberPathSchema,
    "Delete one member of a secret set and its stored value; every other member keeps its value. Returns the SecretSet of DELETE /v1/secret-sets/{secretSetId}/members/{name}.",
  ),
  rest(
    "tumpel_secret_set_delete",
    "DELETE",
    "/v1/secret-sets/{secretSetId}",
    SecretSetPathSchema,
    "Delete a secret set and its stored values; refused while a persona names it. Calls DELETE /v1/secret-sets/{secretSetId}.",
  ),
  rest(
    "tumpel_session_start",
    "POST",
    "/v1/sessions",
    SessionStartSchema,
    "Start a session with its first prompt on the online host of the tenant with the most free box slots, then the most memory available; refused PoolExhausted when every host runs a turn in every slot; it runs its persona's harness at the pinned version, with the persona's files and secret set. Returns the StartedSession of POST /v1/sessions: {session, turn}, before the harness writes anything.",
  ),
  rest(
    "tumpel_session_start_from_issue",
    "POST",
    "/v1/sessions/from-issue",
    SessionStartFromIssueSchema,
    "Start a session from an open issue of a GitHub repository, as tumpel_session_start does, with a first prompt the control plane writes from the issue: work the issue on the branch ticket/<issueNumber>-<slug>, push it and open a draft pull request that closes the issue. Pass the owner and name tumpel_github_list_repositories prints. Returns the StartedSessionFromIssue of POST /v1/sessions/from-issue; issue names the issue and the branch. Refused IssueNotFound for a missing issue and IssueNotOpen for a closed one or a pull request.",
  ),
  rest(
    "tumpel_session_list",
    "GET",
    "/v1/sessions",
    SessionListQuerySchema,
    "List the tenant's sessions, optionally only those in one state or on one host. Returns the Session[] of GET /v1/sessions.",
  ),
  rest(
    "tumpel_session_get",
    "GET",
    "/v1/sessions/{sessionId}",
    SessionPathSchema,
    "Read one session. Returns the Session of GET /v1/sessions/{sessionId}; state is Starting, Idle, Running, Stopping, Stopped or Archived.",
  ),
  rest(
    "tumpel_session_stop",
    "POST",
    "/v1/sessions/{sessionId}/stop",
    SessionPathSchema,
    "Stop a session with no turn running: its host snapshots it and frees its box, and the next tumpel_turn_send boots a fresh box from the snapshots. Returns the Session of POST /v1/sessions/{sessionId}/stop, Stopping until the box is gone and then Stopped; refused while a turn runs or the host is offline.",
  ),
  rest(
    "tumpel_session_archive",
    "POST",
    "/v1/sessions/{sessionId}/archive",
    SessionPathSchema,
    "Archive a Stopped session: delete its snapshots, keep its transcript readable and refuse every later send. Final. Returns the Archived Session of POST /v1/sessions/{sessionId}/archive.",
  ),
  rest(
    "tumpel_session_stop_failures",
    "GET",
    "/v1/sessions/{sessionId}/stop-failures",
    SessionPathSchema,
    "List the stops of a session that failed, oldest first; each returned the session to Idle with its box kept. Returns the StopFailure[] of GET /v1/sessions/{sessionId}/stop-failures: {reason, detail, failedAt}.",
  ),
  rest(
    "tumpel_turn_send",
    "POST",
    "/v1/sessions/{sessionId}/turns",
    SessionPathSchema.extend(TurnSendSchema.shape),
    "Send a session its next prompt. Returns the Turn of POST /v1/sessions/{sessionId}/turns before any output; refused while another turn of the session runs.",
  ),
  rest(
    "tumpel_turn_list",
    "GET",
    "/v1/sessions/{sessionId}/turns",
    SessionPathSchema,
    "List a session's turns, oldest first. Returns the Turn[] of GET /v1/sessions/{sessionId}/turns.",
  ),
  rest(
    "tumpel_turn_get",
    "GET",
    "/v1/turns/{turnId}",
    TurnPathSchema,
    "Read one turn. Returns the Turn of GET /v1/turns/{turnId}; state is Offered, Running, Completed or Failed.",
  ),
  rest(
    "tumpel_turn_failure",
    "GET",
    "/v1/turns/{turnId}/failure",
    TurnPathSchema,
    "Read why a Failed turn failed. Returns the TurnFailure of GET /v1/turns/{turnId}/failure: {reason, detail}.",
  ),
  rest(
    "tumpel_transcript_read",
    "GET",
    "/v1/sessions/{sessionId}/transcript",
    SessionPathSchema.extend(TranscriptQuerySchema.shape),
    "Read a page of a session's harness-native JSONL transcript; turnId keeps one turn's lines, limit and maxBytes cap the page (the transcript chunk size and 32768 bytes by default). Pass compact true to poll a live ClaudeCode turn: it keeps the text the assistant wrote, shows each tool call as one line naming the tool and its first argument, and drops tool results. Pass the cursor of the previous page as after to read on; finished is true when no turn is in flight and no line follows. Returns the TranscriptPage of GET /v1/sessions/{sessionId}/transcript: {sessionState, lines, cursor, finished}.",
  ),
  rest(
    "tumpel_session_handovers",
    "GET",
    "/v1/sessions/{sessionId}/credential-handovers",
    SessionPathSchema,
    "List the credential handovers of a session, oldest first: the variable names each turn offer carried, never their values. Returns the CredentialHandover[] of GET /v1/sessions/{sessionId}/credential-handovers.",
  ),
  rest(
    "tumpel_snapshot_list",
    "GET",
    "/v1/sessions/{sessionId}/snapshots",
    SessionPathSchema,
    "List a session's snapshots in order, each stored or failed with its reason. Returns the Snapshot[] of GET /v1/sessions/{sessionId}/snapshots.",
  ),
  rest(
    "tumpel_snapshot_get",
    "GET",
    "/v1/snapshots/{snapshotId}",
    SnapshotPathSchema,
    "Read one snapshot: its stored size, or why it was not stored. Returns the Snapshot of GET /v1/snapshots/{snapshotId}.",
  ),
];

const PATH_KEY = /\{(\w+)\}/g;

const pathKeys = (path: string): string[] => [...path.matchAll(PATH_KEY)].map((match) => match[1] ?? "");

const toolRequest = (
  tool: ToolDefinition,
  request: { method: Method; path: string },
  args: Record<string, unknown>,
  origin: string,
): Request => {
  const keys = pathKeys(request.path);
  const path = request.path.replace(PATH_KEY, (_, key: string) => encodeURIComponent(String(args[key])));
  const carriesBody = tool.answer === "rest" && (request.method === "POST" || request.method === "PUT");
  const body = Object.fromEntries(Object.entries(args).filter(([key]) => !keys.includes(key)));
  const query =
    request.method === "GET" && Object.keys(body).length > 0
      ? `?${new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]))}`
      : "";
  return new Request(`${origin}${path}${query}`, {
    method: request.method,
    headers: { "content-type": "application/json" },
    ...(carriesBody ? { body: JSON.stringify(body) } : {}),
  });
};

const refusalText = async (answer: Response): Promise<string> => {
  const problem = ProblemSchema.safeParse(await answer.json().catch(() => null));
  if (!problem.success) return `the control plane answered ${answer.status} without a problem document`;
  return `${problem.data.title}: ${problem.data.detail}. ${problem.data.fix}`;
};

const runTool = async (
  tool: ToolDefinition,
  args: Record<string, unknown>,
  dispatch: Dispatch,
  origin: string,
): Promise<ToolResult> => {
  if (tool.request !== null) {
    const answer = await dispatch(toolRequest(tool, tool.request, args, origin));
    if (!answer.ok) return { ok: false, error: await refusalText(answer) };
    if (tool.answer === "rest") {
      const text = answer.status === 204 ? "" : await answer.text();
      return { ok: true, text: text || `${tool.request.method} ${tool.request.path} answered ${answer.status}` };
    }
  }
  if (tool.answer === "memberCommand") return { ok: true, text: memberCommand(MEMBER_WITHOUT_VALUE.parse(args)) };
  if (tool.answer === "circleCIStartCommand") {
    return { ok: true, text: circleCIStartCommand(CIRCLECI_START_WITHOUT_TOKEN.parse(args)) };
  }
  const entry = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "secretSetId"));
  return { ok: true, text: JSON.stringify(ConfigSecretSetSchema.parse(entry)) };
};

interface Bound {
  dispatch: Dispatch;
  origin: string;
}

type Id = string | number | null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const reply = (id: Id, result: unknown, status = 200): Response =>
  Response.json({ jsonrpc: "2.0", id, result }, { status, headers: { "cache-control": "no-store" } });

const refuse = (id: Id, code: number, message: string, status: number, data?: unknown): Response =>
  Response.json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    { status, headers: { "cache-control": "no-store" } },
  );

export const mcpRefusal = (status: number, body: Problem, headers: Record<string, string> = {}): Response => {
  const problem = ProblemSchema.parse(body);
  const answer = refuse(null, UNAUTHORIZED, `${problem.detail}; ${problem.fix}`, status, problem);
  for (const [name, value] of Object.entries(headers)) answer.headers.set(name, value);
  return answer;
};

const takesEventStream = (request: Request): boolean => {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/event-stream") && !accept.includes("application/json") && !accept.includes("*/*");
};

const CARRIED_HEADERS = ["www-authenticate", "access-control-allow-origin", "vary"];

const asEventStream = async (answer: Response): Promise<Response> => {
  if (answer.body === null) return answer;
  const headers = new Headers({
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  for (const name of CARRIED_HEADERS) {
    const value = answer.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(`event: message\ndata: ${await answer.text()}\n\n`, { status: answer.status, headers });
};

const decodeHeader = (value: string): string => {
  const sentinel = BASE64_SENTINEL.exec(value);
  if (!sentinel?.[1]) return value;
  return new TextDecoder().decode(Uint8Array.from(atob(sentinel[1]), (char) => char.charCodeAt(0)));
};

const unsupportedVersion = (id: Id, requested: string): Response =>
  refuse(id, UNSUPPORTED_VERSION, "Unsupported protocol version", 400, { supported: SUPPORTED_VERSIONS, requested });

const toolNamed = (name: unknown): ToolDefinition | undefined =>
  typeof name === "string" ? TOOLS.find((tool) => tool.name === name) : undefined;

const listResult = (): unknown => ({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input),
  })),
});

const callResult = async (id: Id, params: unknown, run: Bound): Promise<Response> => {
  if (!isRecord(params)) return refuse(id, INVALID_PARAMS, "tools/call takes {name, arguments}", 200);
  const tool = toolNamed(params.name);
  if (tool === undefined) return refuse(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`, 200);
  const args = params.arguments;
  if (args !== undefined && !isRecord(args)) {
    return refuse(id, INVALID_PARAMS, `${tool.name} takes its arguments as a JSON object`, 200);
  }
  const parsed = tool.input.safeParse(args ?? {});
  const outcome: ToolResult = parsed.success
    ? await runTool(tool, parsed.data, run.dispatch, run.origin)
    : { ok: false, error: `${tool.name} refused its arguments: ${issues(parsed.error)}` };
  const text = outcome.ok ? outcome.text : outcome.error;
  return reply(id, { content: [{ type: "text", text }], ...(outcome.ok ? {} : { isError: true }) });
};

const initializeResult = (params: unknown): unknown => {
  const wanted = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  return {
    protocolVersion: LEGACY_VERSIONS.includes(wanted) ? wanted : LATEST_LEGACY,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  };
};

const discoverResult = (): unknown => ({
  resultType: "complete",
  supportedVersions: SUPPORTED_VERSIONS,
  capabilities: { tools: {} },
  _meta: { [META_SERVER_INFO]: SERVER_INFO },
  instructions: INSTRUCTIONS,
});

const declaredVersion = (params: unknown): string | null => {
  if (!isRecord(params) || !isRecord(params._meta)) return null;
  const version = params._meta[META_VERSION];
  return typeof version === "string" ? version : null;
};

const headerMismatch = (request: Request, method: string, params: unknown, declared: string): string | null => {
  const header = (name: string): string | null => request.headers.get(name);
  const version = header("mcp-protocol-version");
  if (version === null) return "MCP-Protocol-Version is missing";
  if (version !== declared) {
    return `MCP-Protocol-Version header value '${version}' does not match the _meta value '${declared}'`;
  }
  const named = header("mcp-method");
  if (named === null) return "Mcp-Method is missing";
  if (named !== method) return `Mcp-Method header value '${named}' does not match body value '${method}'`;
  if (method !== "tools/call") return null;
  const name = isRecord(params) && typeof params.name === "string" ? params.name : "";
  const carried = header("mcp-name");
  if (carried === null) return "Mcp-Name is missing";
  if (decodeHeader(carried) !== name) return `Mcp-Name header value '${carried}' does not match body value '${name}'`;
  return null;
};

const modern = async (
  request: Request,
  id: Id,
  method: string,
  params: unknown,
  declared: string,
  run: Bound,
): Promise<Response> => {
  if (declared !== MODERN_VERSION) return unsupportedVersion(id, declared);
  const mismatch = headerMismatch(request, method, params, declared);
  if (mismatch !== null) return refuse(id, HEADER_MISMATCH, `Header mismatch: ${mismatch}`, 400);
  if (method === "server/discover") return reply(id, discoverResult());
  if (method === "tools/list") return reply(id, listResult());
  if (method === "tools/call") return callResult(id, params, run);
  return refuse(id, METHOD_NOT_FOUND, `Method not found: ${method}`, 404);
};

const legacy = async (request: Request, id: Id, method: string, params: unknown, run: Bound): Promise<Response> => {
  const version = request.headers.get("mcp-protocol-version");
  if (method !== "initialize" && version !== null && !LEGACY_VERSIONS.includes(version)) {
    return unsupportedVersion(id, version);
  }
  if (method === "initialize") return reply(id, initializeResult(params));
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, listResult());
  if (method === "tools/call") return callResult(id, params, run);
  return refuse(id, METHOD_NOT_FOUND, `Method not found: ${method}`, 404);
};

const answer = async (request: Request, authorize: Authorize): Promise<Response> => {
  const dispatch = await authorize();
  if (dispatch instanceof Response) return dispatch;
  const run: Bound = { dispatch, origin: new URL(request.url).origin };
  const body: unknown = await request.json().catch(() => null);
  if (body === null) return refuse(null, PARSE_ERROR, "the request body is not JSON", 400);
  if (Array.isArray(body)) {
    return refuse(null, INVALID_REQUEST, "this endpoint takes one JSON-RPC message per request", 400);
  }
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return refuse(null, INVALID_REQUEST, 'a message must be {"jsonrpc": "2.0", "method": ...}', 400);
  }
  const { method, params, id } = body;
  if (id === undefined || id === null) return new Response(null, { status: 202 });
  if (typeof id !== "string" && typeof id !== "number") {
    return refuse(null, INVALID_REQUEST, "a message id is a string or a number", 400);
  }
  const declared = declaredVersion(params);
  return declared === null
    ? legacy(request, id, method, params, run)
    : modern(request, id, method, params, declared, run);
};

export const mcpEndpoint = async (request: Request, authorize: Authorize): Promise<Response> => {
  if (request.method !== "POST") {
    return refuse(
      null,
      INVALID_REQUEST,
      `${MCP_PATH} answers a POST; it opens no stream of its own and keeps no session`,
      405,
    );
  }
  const answered = await answer(request, authorize);
  return takesEventStream(request) ? asEventStream(answered) : answered;
};
