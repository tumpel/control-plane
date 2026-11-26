import {
  ApiKeyMemberSchema,
  ApiKeyUpdateSchema,
  ClaudeSetupListQuerySchema,
  ClaudeSetupPathSchema,
  ClaudeSetupStartSchema,
  ConfigApiKeySchema,
  ConfigSecretSetSchema,
  ConfigSecretValueSchema,
  ConfigSecretVariableSchema,
  ConfigSubscriptionTokenSchema,
  ConnectorPathSchema,
  ConnectorUpdateSchema,
  ConnectorWritePathSchema,
  CredentialFileUpdateSchema,
  DevicePathSchema,
  DraftTriggerTestSchema,
  EditPersonaFilePatchSchema,
  EnrolmentTokenMintSchema,
  EnrolmentTokenPathSchema,
  EventQuerySchema,
  GitHubInstallationPathSchema,
  GitHubRepositoryPathSchema,
  HarnessPathSchema,
  HarnessPinCreateSchema,
  HostLabelsPatchSchema,
  HostLabelsSchema,
  HostPathSchema,
  InvitationCreateSchema,
  InvitationPathSchema,
  MemberPathSchema,
  MetricPathSchema,
  MetricSeriesQuerySchema,
  MetricTurnQuerySchema,
  MetricWindowSchema,
  OAuthConnectorCreateSchema,
  OAuthGrantPathSchema,
  OpenRouterAuthorizationPathSchema,
  OpenRouterAuthorizationStartSchema,
  PersonaCreateSchema,
  PersonaFilePatchKindSchema,
  PersonaFileUploadRequestSchema,
  PersonaPatchSchema,
  PersonaPathSchema,
  PersonaUpdateSchema,
  PrebuildListQuerySchema,
  PrebuildPathSchema,
  PrebuildPreviewOfSuppliedSchema,
  PrebuildPreviewSourceSchema,
  PrebuildStartSchema,
  PrebuildTemplatePullRequestOpenSchema,
  PrebuildTemplatePullRequestQuerySchema,
  PrebuildTemplateVersionPathSchema,
  ProblemSchema,
  PutPersonaFilePatchSchema,
  RemovePersonaFilePatchSchema,
  SecretMemberPathSchema,
  SecretSetPatchSchema,
  SecretSetPathSchema,
  SecretVariableMemberSchema,
  SecretVariableUpdateSchema,
  SessionPathSchema,
  SessionStartFromIssueSchema,
  SessionStartSchema,
  SessionStopQuerySchema,
  SessionTagsPatchSchema,
  SessionTagsSchema,
  SnapshotPathSchema,
  StaticConnectorCreateSchema,
  SteerCreateSchema,
  StoredTriggerTestSchema,
  SubscriptionCreateSchema,
  SubscriptionListQuerySchema,
  SubscriptionPathSchema,
  SubscriptionPauseSchema,
  SubscriptionTokenMemberSchema,
  SubscriptionTokenUpdateSchema,
  TenantConfigApplySchema,
  TenantConfigPlanRequestSchema,
  TenantLimitsSetSchema,
  TranscriptQuerySchema,
  TriggerCreateSchema,
  TriggerPatchSchema,
  TriggerPathSchema,
  TurnPathSchema,
  TurnSendSchema,
} from "@tumpel/schemas";
import { z } from "zod";
import manifest from "../package.json";
import { issues, type Problem, readBoundedJson } from "./http";
import { MCP_PATH } from "./oauth";
import { PagedSessionListQuerySchema } from "./sessions";

const MODERN_VERSION = "2026-07-28";
const LATEST_LEGACY = "2025-11-25";
const LEGACY_VERSIONS = [LATEST_LEGACY, "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/;

const SERVER_INFO = { name: "tumpel", version: manifest.version };

const INSTRUCTIONS =
  "tumpel runs coding harness sessions on machines your tenant owns. Start here:\n1. tumpel_whoami: check the endpoint and tenant you act in.\n2. tumpel_persona_list: pick the persona a session runs, its harness and secret set; tumpel_persona_create makes one, with a secretSetId from tumpel_secret_set_list.\n3. tumpel_session_start: start a session with a persona, a model, a first prompt and the repository as https://github.com/owner/name.\n4. tumpel_transcript_read with compact true follows the turn, and tumpel_turn_get reads its state; tumpel_turn_send sends the next prompt, tumpel_session_stop frees the box. Never wait for a turn inside your own turn: end your turn and let a subscription event wake you when it ends.\n5. For a long job, such as working through a list of issues, start a session, then give it a subscription with tumpel_subscription_create: the plan, the goal, the events to react to, the crew tags and an expiry. Each event of its crew, the sessions that carry those tags, then becomes a new turn of that session.\n6. To start a session whenever something happens on GitHub, such as a pull request leaving draft, a push, a commit status or a label on an issue, create a trigger with tumpel_trigger_create: the event type, conditions on the webhook payload, a persona, a model and a prompt with {{field}} placeholders. Check it first on a sample payload with tumpel_trigger_test. Tumpel only listens, so the prompt tells the session how to report back. Only an Owner creates a trigger that starts sessions. A session may create a trigger targeting itself with sessionId, which sends it one turn and then deletes itself.\nA session with a subscription gives heavy work to crew sessions it starts with tumpel_session_start, which inherit its crew tags, then ends its turn: crew events wake it, so it never sleeps or polls inside a turn. It keeps each crew task small enough to finish well inside the turn limit, and when a crew turn ends TurnTimedOut it splits the work and resends it. It arms auto-merge on a crew pull request only after the review has passed, unless the repository ruleset requires the review check. It pauses with tumpel_subscription_pause and a short message when it needs a decision, and calls tumpel_subscription_complete once the goal holds. An agent inside a tumpel box never creates or resumes a subscription; it tells its person, who sets it up.\nA Foreman waiting on a crew pull request creates targeted triggers after the pull request is pushed: one per thing it waits on, such as a status with context agent-review on the head sha, a check_suite completed by github-actions on the head sha or a pull_request_review submitted on the pull request, plus a pull_request trigger for synchronize and closed, so pushes, merge and close wake it too. Each trigger's prompt names the pull request and the {{field}} values the Foreman needs. It then reads the current state once with gh. It ends its turn and never polls. When it wakes, it reads the pull request before acting. On a push, it replaces its triggers for the old head with triggers for the new one. It creates a new trigger if it still waits, and deletes its other triggers for that pull request once it is done. A refused send leaves its trigger armed and is shown in tumpel_events_list, but nothing re-sends it. It gives each trigger a unique name, such as wake-<session>-pr-<n>-<event>.\nIf a turn fails, tumpel_turn_failure says why and what to do. Secret values and sign-in codes never pass through MCP; the person enters them in the dashboard or on the CLI.\n\nIf a start or send is refused, use the problem code. For ModelUnsupported, pick a model listed by tumpel_harness_list. For HarnessNotInCatalog, start a fresh session so it uses the current catalog version. For ImageNotReleased, tell the person. For NoCredential or CredentialExpired, ask the person to fix the credential. For PoolExhausted, NoHostAvailable, HostDegraded or HostOffline, end the turn and wait for CapacityAvailable if your subscription lists it. Otherwise, move the work onto a session that has room. Never poll.";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;
const UNAUTHORIZED = -32001;

export type ToolResult = { ok: true; text: string } | { ok: false; error: string };

export type Dispatch = (request: Request) => Promise<Response>;

export type Authorize = () => Promise<Dispatch | Response>;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface ToolDefinition {
  name: string;
  description: string;
  input: z.ZodType<Record<string, unknown>>;
  request: { method: Method; path: string; query?: string[] } | null;
  answer: "rest" | "configSecretSet" | "memberCommand" | "connectorTokenCommand";
}

const DONE: Record<string, string> = {
  tumpel_devices_revoke: "Device signed out",
  tumpel_member_remove: "Member removed",
  tumpel_invitation_revoke: "Invitation revoked",
  tumpel_host_revoke_token: "Enrolment token revoked",
  tumpel_harness_unpin: "Pin removed",
  tumpel_persona_delete: "Persona deleted",
  tumpel_subscription_delete: "Subscription deleted",
  tumpel_trigger_delete: "Trigger deleted",
  tumpel_github_delete: "GitHub installation removed",
  tumpel_oauth_grant_revoke: "OAuth grant revoked",
  tumpel_secret_set_delete: "Secret set deleted",
  tumpel_connector_delete: "Connector deleted",
};

const connectorTokenCommand = (args: z.infer<typeof ConnectorPathSchema>): string =>
  `Connector tokens never pass through MCP and this tool writes nothing. Pipe the token into this command on your machine: tumpel connector set-token ${args.connectorId} --stdin`;

const REPOSITORY_FORMAT =
  "The GitHub repository, as https://github.com/owner/name; owner/name and github.com/owner/name are accepted too.";

const NO_ARGUMENTS = z.object({});

const TRIGGER_TEST = z
  .object({
    kind: z.enum(["Stored", "Draft"]),
    triggerId: StoredTriggerTestSchema.shape.triggerId.optional(),
    trigger: DraftTriggerTestSchema.shape.trigger.optional(),
    payload: StoredTriggerTestSchema.shape.payload,
  })
  .strict();

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
  "Secret values never pass through MCP; they arrive through the dashboard, the OAuth connections, tumpel config apply or tumpel secret-set set-member --stdin on the CLI. This tool writes nothing: each member names its kind (Variable, ApiKey, or SubscriptionToken with its expiresAt), a provider for a credential, and only the environment variable (valueFrom.env) its value is read from, which the server cannot resolve. Returns the entry to put in secretSets of the tenant config file; export each named variable on your machine and run tumpel config apply <file>, which writes the values.";

const MEMBER_WITHOUT_VALUE = SecretSetPathSchema.extend({
  member: z.discriminatedUnion("kind", [
    SecretVariableMemberSchema.strict(),
    ApiKeyMemberSchema.strict(),
    SubscriptionTokenMemberSchema.strict(),
  ]),
}).strict();

const PATCH_WITHOUT_VALUES = SecretSetPathSchema.extend({
  name: SecretSetPatchSchema.shape.name,
  secrets: z
    .array(
      z.discriminatedUnion("kind", [
        SecretVariableUpdateSchema.omit({ value: true }).strict(),
        ApiKeyUpdateSchema.omit({ value: true }).strict(),
        SubscriptionTokenUpdateSchema.omit({ value: true }).strict(),
        CredentialFileUpdateSchema.omit({ value: true }).strict(),
      ]),
    )
    .optional(),
}).strict();

const memberCommand = (args: z.infer<typeof MEMBER_WITHOUT_VALUE>): string => {
  const { member } = args;
  const kind = member.kind.replace(/\B([A-Z])/g, "-$1").toLowerCase();
  const flags = [`--name ${member.name}`];
  if (member.kind !== "Variable") flags.push(`--provider ${member.provider}`);
  if (member.kind === "SubscriptionToken") flags.push(`--expires-at ${member.expiresAt}`);
  return `Secret values never pass through MCP and this tool writes nothing. Pipe the value of ${member.name} into this command on your machine: tumpel secret-set set-member ${kind} ${args.secretSetId} ${flags.join(" ")} --stdin`;
};

const NO_SECRET_VALUES = TenantConfigApplySchema.extend({
  secretValues: z
    .array(ConfigSecretValueSchema.pick({ env: true }).strict())
    .max(
      0,
      "secret values never pass through MCP; they arrive through the dashboard, the OAuth connections, tumpel config apply or tumpel secret-set set-member --stdin on the CLI",
    ),
});

const rest = (
  name: string,
  method: Method,
  path: string,
  input: z.ZodType<Record<string, unknown>>,
  description: string,
): ToolDefinition => ({
  name,
  description,
  input,
  request: { method, path },
  answer: "rest",
});

export const TOOLS: ToolDefinition[] = [
  {
    name: "tumpel_whoami",
    description:
      "Name the endpoint you signed in to and the tenant and principal this connector acts as. Returns {endpoint, tenant, principal}.",
    input: NO_ARGUMENTS,
    request: { method: "GET", path: "/v1/whoami" },
    answer: "rest",
  },
  rest("tumpel_devices_list", "GET", "/v1/devices", NO_ARGUMENTS, "List the devices signed in as you."),
  rest(
    "tumpel_devices_revoke",
    "DELETE",
    "/v1/devices/{deviceId}",
    DevicePathSchema,
    "Sign a device out; its token stops working at once.",
  ),
  rest(
    "tumpel_tenants",
    "GET",
    "/v1/whoami/tenants",
    NO_ARGUMENTS,
    "List every tenant you belong to, with your role there. Returns {tenant, role, createdAt}. This connector acts in one of them; to act in another, connect again and choose it on the consent page.",
  ),
  rest(
    "tumpel_member_list",
    "GET",
    "/v1/members",
    NO_ARGUMENTS,
    "List the people of the tenant. Returns principalId, tenantId, email and role (Owner or Member).",
  ),
  rest(
    "tumpel_member_remove",
    "DELETE",
    "/v1/members/{principalId}",
    MemberPathSchema,
    "Remove a person from the tenant and sign out their devices and tokens there. Owner only; refused LastOwner for the tenant's last Owner.",
  ),
  rest(
    "tumpel_invitation_create",
    "POST",
    "/v1/invitations",
    InvitationCreateSchema,
    "Invite an email to the tenant as Owner or Member for seven days. Owner only. Returns {invitation, acceptUrl}. No email is sent: give acceptUrl to the invitee, who opens it signed in to Cloudflare Access as that email. acceptUrl is shown only now.",
  ),
  rest("tumpel_invitation_list", "GET", "/v1/invitations", NO_ARGUMENTS, "List the tenant's open invitations."),
  rest(
    "tumpel_invitation_revoke",
    "DELETE",
    "/v1/invitations/{invitationId}",
    InvitationPathSchema,
    "Revoke an open invitation; its link stops working. Owner only.",
  ),
  rest(
    "tumpel_host_mint_token",
    "POST",
    "/v1/enrolment-tokens",
    EnrolmentTokenMintSchema,
    "Mint a one-time enrolment token for a new host; expiresInSeconds is how long the token enrols a host. Returns {enrolmentToken, token, installCommand}. The token is shown once. installCommand holds no token and reads it from stdin: run installCommand on the new x86_64 host with the token on stdin; it downloads the supervisor, installs it and enrols the host.",
  ),
  rest(
    "tumpel_host_list_tokens",
    "GET",
    "/v1/enrolment-tokens",
    NO_ARGUMENTS,
    "List the tenant's unused, unexpired enrolment tokens, without their token values. Returns enrolmentTokenId, principalId, expiresAt and createdAt.",
  ),
  rest(
    "tumpel_host_revoke_token",
    "DELETE",
    "/v1/enrolment-tokens/{enrolmentTokenId}",
    EnrolmentTokenPathSchema,
    "Revoke an unused enrolment token; no host can enrol with it.",
  ),
  rest(
    "tumpel_host_list",
    "GET",
    "/v1/hosts",
    NO_ARGUMENTS,
    "List the tenant's hosts with their presence; state is Enrolled, Online, Offline or Revoked.",
  ),
  rest(
    "tumpel_host_list_usage",
    "GET",
    "/v1/hosts/usage",
    NO_ARGUMENTS,
    "List the box slots and last reported usage of each host of the tenant that has connected since it enrolled and is not revoked. Returns hostId, boxCapacity, boxesRunning (the tenant's Offered and Running turns on the host), boxesWarm (its Idle and Stopping boxes), loadAverage, memoryAvailableMib, the disk and memory budgets and what boxes hold of them, with the memory of boxes offered since its last report counted as held, and updatedAt, when the last Hello or Heartbeat arrived.",
  ),
  rest(
    "tumpel_host_get",
    "GET",
    "/v1/hosts/{hostId}",
    HostPathSchema,
    "Read one host with its presence, labels and the latest supervisor update phase and failure it reported.",
  ),
  rest(
    "tumpel_host_revoke",
    "POST",
    "/v1/hosts/{hostId}/revoke",
    HostPathSchema,
    "Revoke a host: its channel closes and it cannot connect again.",
  ),
  rest(
    "tumpel_host_set_labels",
    "PUT",
    "/v1/hosts/{hostId}/labels",
    HostPathSchema.extend(HostLabelsSchema.shape),
    "Replace every label of a host.",
  ),
  rest(
    "tumpel_host_patch_labels",
    "PATCH",
    "/v1/hosts/{hostId}/labels",
    HostPathSchema.extend(HostLabelsPatchSchema.shape),
    "Add the labels in add and remove the labels in remove; every other label of the host stays.",
  ),
  rest(
    "tumpel_harness_list",
    "GET",
    "/v1/harnesses",
    NO_ARGUMENTS,
    "List the harness catalog: every harness and version a tenant can pin, and for each credential it accepts, its modelSupport: Listed with the models it runs with that credential, or ProviderChecked when it takes any model its provider serves.",
  ),
  rest(
    "tumpel_harness_list_pins",
    "GET",
    "/v1/harnesses/pins",
    NO_ARGUMENTS,
    "List every harness of the catalog with the version new sessions of it run and whether the tenant pins it.",
  ),
  rest(
    "tumpel_harness_pin",
    "PUT",
    "/v1/harnesses/pins",
    HarnessPinCreateSchema,
    "Pin a harness to a version of the catalog, replacing its pin.",
  ),
  rest(
    "tumpel_harness_unpin",
    "DELETE",
    "/v1/harnesses/pins/{harness}",
    HarnessPathSchema,
    "Remove the tenant's pin for a harness.",
  ),
  rest(
    "tumpel_limits_get",
    "GET",
    "/v1/limits",
    NO_ARGUMENTS,
    "Read the limits the tenant runs under. Returns {source, profile}: source is Free or Configured for the preset of the tenant's tier, or Custom for a profile of its own; profile has writesPerMinute, hostFramesPerMinute and usage, its budgets of {measure, window, limit}; a request rate is a Requests per Minute budget.",
  ),
  rest(
    "tumpel_limits_set",
    "PUT",
    "/v1/limits",
    TenantLimitsSetSchema,
    "Set the limits the tenant runs under, Owner only: pass {reset: true} to drop the tenant's own profile and run under the preset of its tier, or every field of a profile (writesPerMinute, hostFramesPerMinute, usage). Refused InvalidRequest past the deployment's ceiling. A Free tenant may set values at or below the Free preset only; anything higher is refused AboveFreeTier. This tool never changes the tier; only the operator of the deployment moves a tenant between tiers. A host takes a new frame limit when it next connects.",
  ),
  rest(
    "tumpel_release_current",
    "GET",
    "/v1/releases/current",
    NO_ARGUMENTS,
    "Read the current release: releaseVersion, commit, channelProtocolVersion, the supervisor binary of each architecture and the guest image of each harness version and architecture. A session is placed only on a host whose architecture has an image of its harness version here.",
  ),
  rest(
    "tumpel_persona_create",
    "POST",
    "/v1/personas",
    PersonaCreateSchema,
    "Create a persona: the harness its sessions run, the secretSetId of the secret set they run on, connectorIds, the connectors its sessions get ([] for none), the harness's own config files at paths the harness catalog accepts, each Inline (base64 content, up to 65536 bytes) or Stored (digest and sizeBytes of an uploaded file), optionally boxMemoryMib, the memory of each box its sessions boot, from 512 up to 65536, 2048 by default, optionally boxDiskMib, the disk of each box, from 32768 (the default) up to 262144, and optionally boxRetention, what happens to a session's box after each turn: Off tears it down once its snapshot is stored, Warm keeps it until the session is stopped or archived, and Auto, the default, keeps it until placement evicts it to make room.",
  ),
  rest(
    "tumpel_persona_upload_file",
    "POST",
    "/v1/personas/file-uploads",
    PersonaFileUploadRequestSchema,
    "Presign the upload of one persona file larger than 65536 bytes, named by the sha256 digest and size of its bytes. Returns uploadUrl and uploadExpiresAt: PUT the bytes to uploadUrl before uploadExpiresAt, then name the file as Stored by digest in a persona write.",
  ),
  rest(
    "tumpel_persona_list",
    "GET",
    "/v2/personas",
    NO_ARGUMENTS,
    "List the tenant's personas with file paths, digests, sizes and timestamps. Use tumpel_persona_get to read file content.",
  ),
  rest("tumpel_persona_get", "GET", "/v1/personas/{personaId}", PersonaPathSchema, "Read one persona."),
  rest(
    "tumpel_persona_update",
    "PUT",
    "/v1/personas/{personaId}",
    PersonaPathSchema.extend(PersonaUpdateSchema.shape),
    "Replace a persona's name, secret set, connectorIds (the whole list; [] for none), box memory, box disk and whole file set; sessions already started keep their connectors; its harness is fixed at create, a file left out is deleted, and a boxMemoryMib or boxDiskMib left out goes back to its default of 2048 or 32768 MiB, and a boxRetention left out goes back to Auto. Name an unchanged file as Stored by its digest and sizeBytes.",
  ),
  rest(
    "tumpel_persona_patch",
    "PATCH",
    "/v1/personas/{personaId}",
    PersonaPathSchema.extend(PersonaPatchSchema.shape),
    "Change only the persona fields you send: name, secretSetId, connectorIds (the whole list; [] for none), boxMemoryMib, boxDiskMib or boxRetention. Every field you leave out and every file stay as they are; its harness is fixed at create. tumpel_persona_patch_file changes one file.",
  ),
  rest(
    "tumpel_persona_patch_file",
    "POST",
    "/v1/personas/{personaId}/file-patches",
    PersonaPathSchema.extend({
      kind: PersonaFilePatchKindSchema,
      file: PutPersonaFilePatchSchema.shape.file.optional(),
      path: RemovePersonaFilePatchSchema.shape.path.optional(),
      oldText: EditPersonaFilePatchSchema.shape.oldText.optional(),
      newText: EditPersonaFilePatchSchema.shape.newText.optional(),
    }),
    "Change one file of a persona and leave every other file as it is. kind Put adds or replaces file, given inline or as Stored by digest and sizeBytes; kind Remove deletes the file at path; kind Edit replaces the one occurrence of oldText in the UTF-8 file at path with newText. Returns the persona. Refused NotFound when Remove or Edit names no file of the persona, and InvalidRequest when oldText occurs other than once or the result breaks the limits and paths a create checks.",
  ),
  rest(
    "tumpel_persona_delete",
    "DELETE",
    "/v1/personas/{personaId}",
    PersonaPathSchema,
    "Delete a persona and its files; a file another persona holds stays. Refused while any session of the persona is neither Failed nor Archived. Archived sessions stay readable.",
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
    "Read the stage's GitHub App as the tenant sees it. app.state is Ready with the appSlug, or AppMissing with the setupUrl where a person creates the stage's GitHub App once. tumpel_github_list lists the tenant's installations.",
  ),
  rest(
    "tumpel_github_list",
    "GET",
    "/v1/github-connection/installations",
    NO_ARGUMENTS,
    "List every GitHub account or organization the tenant connected, one installation of the stage's GitHub App each. Returns installationId, accountLogin, status (Active or Suspended), createdAt and updatedAt.",
  ),
  rest(
    "tumpel_github_start",
    "POST",
    "/v1/github-connection/start",
    NO_ARGUMENTS,
    "Get the URL where a person installs the stage's GitHub App on one more account or organization for the tenant; installations already connected stay. Returns {installUrl, expiresAt}. Hand installUrl to the user to open in a browser before expiresAt; afterwards every turn on a repository of that account gets a short-lived installation token as GITHUB_TOKEN and GH_TOKEN.",
  ),
  rest(
    "tumpel_github_delete",
    "DELETE",
    "/v1/github-connection/installations/{installationId}",
    GitHubInstallationPathSchema,
    "Remove one GitHub installation from the tenant, by the installationId tumpel_github_list prints; turns on repositories of its account then use the secret set's GITHUB_TOKEN. The installation stays on GitHub until a person uninstalls the App there.",
  ),
  rest(
    "tumpel_github_list_repositories",
    "GET",
    "/v1/github-connection/repositories",
    NO_ARGUMENTS,
    "List the repositories every GitHub installation of the tenant covers. Returns owner, name, defaultBranch, private and htmlUrl; refused GitHubNotConnected until the App is installed with tumpel_github_start.",
  ),
  rest(
    "tumpel_github_list_issues",
    "GET",
    "/v1/github-connection/repositories/{owner}/{name}/issues",
    GitHubRepositoryPathSchema,
    "List the open issues of a repository an installation of the tenant covers, most recently updated first, without pull requests. Returns issueNumber, title, htmlUrl, labels and updatedAt.",
  ),
  rest(
    "tumpel_oauth_grant_list",
    "GET",
    "/v1/oauth-grants",
    NO_ARGUMENTS,
    "List the OAuth clients, such as this connector or the dashboard, that hold a live token for you in this tenant. Returns grantId, clientId, clientName, redirectOrigin and lastIssuedAt.",
  ),
  rest(
    "tumpel_oauth_grant_revoke",
    "DELETE",
    "/v1/oauth-grants/{grantId}",
    OAuthGrantPathSchema,
    "Revoke one of your OAuth grants: every access and refresh token of the grant stops working at once, so revoking this connector's own grant signs it out.",
  ),
  rest(
    "tumpel_config_plan",
    "POST",
    "/v1/tenant-config/plan",
    TenantConfigPlanRequestSchema,
    "Plan the changes that make the tenant match a tenant config, and change nothing. Send the config, the sha256 digest and sizeBytes of each persona file by its from path, the expiresAt of each expiry variable, and in secretValues the names of the variables apply will send, never their values; an empty list keeps every kept secret set as it is, and any other list must name every variable the config names. A persona, secret set or pin the config leaves out is deleted. Returns each change with its action, resource, name and description.",
  ),
  rest(
    "tumpel_config_apply",
    "POST",
    "/v1/tenant-config/apply",
    NO_SECRET_VALUES,
    "Replace the tenant config with this one, all of it or nothing: every change of tumpel_config_plan is checked first, then written in one transaction, so a refused change leaves the tenant as it was; whatever the config leaves out is deleted, and host labels are written after that commit. Secret values never pass through MCP, so secretValues must be empty: a secret set the config keeps keeps its values, and a config that creates or updates a secret set is refused for the missing values, which arrive through the dashboard, the OAuth connections or tumpel config apply on the CLI. Send each persona file Inline (base64 content) or Stored by digest.",
  ),
  rest(
    "tumpel_connection_list",
    "GET",
    "/v1/connections",
    NO_ARGUMENTS,
    "List one row per connection kind: GitHub and OpenRouter, each NotConfigured, NotConnected or Connected with what it is connected as: GitHub logins or the secret sets that hold an OpenRouter key.",
  ),
  rest(
    "tumpel_prebuild_start",
    "POST",
    "/v1/prebuilds",
    PrebuildStartSchema.extend({ repository: PrebuildStartSchema.shape.repository.describe(REPOSITORY_FORMAT) }),
    "Start a prebuild of a repository's default branch on one of the tenant's online Amd64 hosts that builds no other prebuild. personaId names the persona whose secret set's GITHUB_TOKEN reads the repository when the GitHub App installation does not cover it, and whose harness version picks the guest image; the host clones with an installation token that reads the repository's contents. Returns the prebuild; a stored or running prebuild with the same key comes back unless rebuild is true. Refused DevcontainerMissing, naming the templates, when the repository holds no devcontainer.json; open a template pull request first. Refused NoHostAvailable when no such host is free.",
  ),
  rest(
    "tumpel_prebuild_list",
    "GET",
    "/v1/prebuilds",
    PrebuildListQuerySchema,
    "List the prebuilds of one repository, or of the whole tenant when repository is left out, newest first.",
  ),
  rest(
    "tumpel_prebuild_list_latest",
    "GET",
    "/v1/prebuilds/latest",
    NO_ARGUMENTS,
    "List the newest prebuild of each repository the tenant has prebuilt, ordered by repository.",
  ),
  rest(
    "tumpel_claude_setup_start",
    "POST",
    "/v1/claude-setups",
    ClaudeSetupStartSchema,
    "Mint a Claude subscription token for a secret set without installing Claude Code: starts a short-lived box on an Online host that runs claude setup-token from the pinned Claude Code, with no secret set member and no GitHub token. Returns the setup in state Starting; poll tumpel_claude_setup_get until it is AwaitingCode, give the person its signInUrl, and have them paste the code the sign-in page shows into the dashboard or tumpel claude-setup submit-code --stdin, since the code never passes through MCP. With harness Codex the box runs codex login --device-auth instead: give the person the signInUrl and userCode of AwaitingCode, and the box stores its auth.json as the CredentialFile CODEX_AUTH_JSON once they sign in, with no code to submit. With harness Gemini the box runs the pinned gemini sign-in: give the person the signInUrl of AwaitingCode, have them submit the code Google shows the same way within 300 seconds, and the box stores its oauth_creds.json as the CredentialFile GEMINI_OAUTH_CREDS_JSON. Refused NoHostOnline when no Online host can run the box. A start fails the set's running setup Superseded.",
  ),
  rest(
    "tumpel_claude_setup_list",
    "GET",
    "/v1/claude-setups",
    ClaudeSetupListQuerySchema,
    "List the running Claude setup of one secret set, as tumpel_claude_setup_get reads it, to resume it. Returns an empty list, or the one setup still Starting, AwaitingCode or Minting, since a set runs one setup at a time.",
  ),
  rest(
    "tumpel_claude_setup_get",
    "GET",
    "/v1/claude-setups/{claudeSetupId}",
    ClaudeSetupPathSchema,
    "Read one Claude setup; a setup read past the end of its phase reads Failed. Returns the setup; status.state is Starting with urlDueAt, AwaitingCode with signInUrl and codeDueAt, Minting with tokenDueAt, Completed with the member CLAUDE_CODE_OAUTH_TOKEN and its expiresAt, or Failed with reason SetupUrlMissing, CodeRejected, SetupTimedOut, TokenNotStored or NoHostOnline and a detail naming the fix. It never carries the token.",
  ),
  rest(
    "tumpel_openrouter_authorize",
    "POST",
    "/v1/openrouter-connection/authorize",
    OpenRouterAuthorizationStartSchema,
    "Start minting an OpenRouter API key into a secret set through OpenRouter's PKCE flow, so the person copies no key. Takes {secretSetId}; the browser lands on the secret set's page afterwards. Returns the authorization, AwaitingCallback with authorizeUrl and callbackDueAt, 10 minutes out. Give the person authorizeUrl; OpenRouter sends their browser back to the control plane, which spends the code and stores the key as OPENROUTER_API_KEY for OpenRouter. The code and the key never pass through MCP. Read the outcome with tumpel_openrouter_get_authorization.",
  ),
  rest(
    "tumpel_connector_list",
    "GET",
    "/v1/connectors",
    NO_ARGUMENTS,
    "List the tenant's connectors, the remote MCP servers its personas can give sessions: each Static (one token) or OAuth, with its url and status, NotConnected, Connected, Disconnected or AuthorizationFailed with the reason and the fix. Credentials are never returned.",
  ),
  rest(
    "tumpel_connector_get",
    "GET",
    "/v1/connectors/{connectorId}",
    ConnectorPathSchema,
    "Read one connector with its status; after tumpel_connector_authorize, read it to learn whether the person finished consent.",
  ),
  rest(
    "tumpel_connector_create_static",
    "POST",
    "/v1/static-connectors",
    StaticConnectorCreateSchema,
    "Create a connector for a remote MCP server that takes one bearer token, such as a GitHub personal access token: {name, url}, url the server's public https address. Owner only. It reads NotConnected until its token is set with tumpel_connector_set_token.",
  ),
  rest(
    "tumpel_connector_create_oauth",
    "POST",
    "/v1/oauth-connectors",
    OAuthConnectorCreateSchema,
    "Create a connector for a remote MCP server that signs in with OAuth: {name, url}, url the server's public https address. Owner only. It reads NotConnected until tumpel_connector_authorize and the person's consent connect it.",
  ),
  {
    name: "tumpel_connector_set_token",
    description:
      "Draft the write of a static connector's token. Tokens never pass through MCP and this tool writes nothing. Returns the tumpel connector set-token command that reads the token on stdin and stores it.",
    input: ConnectorPathSchema,
    request: { method: "GET", path: "/v1/connectors/{connectorId}" },
    answer: "connectorTokenCommand",
  },
  {
    name: "tumpel_connector_authorize",
    description:
      "Start connecting an OAuth connector. Owner only. Returns authorizeUrl and callbackDueAt, 10 minutes out: give the person authorizeUrl to open in a browser and approve; the provider sends the browser back to the control plane, which stores the grant. Read the outcome with tumpel_connector_get. Refused ConnectorDiscoveryFailed or ConnectorRegistrationUnsupported, each with the fix. Pass the updatedAt of your last read of the connector; refused ConnectorChanged when it changed since, so read it again.",
    input: ConnectorWritePathSchema,
    request: { method: "POST", path: "/v1/oauth-connectors/{connectorId}/authorize", query: ["updatedAt"] },
    answer: "rest",
  },
  {
    name: "tumpel_connector_update",
    description:
      "Rename a connector. Owner only. Its url and credential kind are fixed; a new address needs a new connector. Pass the updatedAt of your last read of the connector; refused ConnectorChanged when it changed since, so read it again.",
    input: ConnectorWritePathSchema.extend(ConnectorUpdateSchema.shape),
    request: { method: "PUT", path: "/v1/connectors/{connectorId}", query: ["updatedAt"] },
    answer: "rest",
  },
  {
    name: "tumpel_connector_clear_credential",
    description:
      "Disconnect a connector. Owner only. New turns that need it are refused; running turns keep it until they end, and stopping them cuts it off sooner. The control plane deletes its credential once no running turn uses it; revoke the grant on the provider's site too. Pass the updatedAt of your last read of the connector; refused ConnectorChanged when it changed since, so read it again.",
    input: ConnectorWritePathSchema,
    request: { method: "DELETE", path: "/v1/connectors/{connectorId}/credential", query: ["updatedAt"] },
    answer: "rest",
  },
  {
    name: "tumpel_connector_delete",
    description:
      "Delete a connector and its credential. Owner only. Refused ConnectorInUse while a persona lists it or a running turn uses it. Pass the updatedAt of your last read of the connector; refused ConnectorChanged when it changed since, so read it again.",
    input: ConnectorWritePathSchema,
    request: { method: "DELETE", path: "/v1/connectors/{connectorId}", query: ["updatedAt"] },
    answer: "rest",
  },
  rest(
    "tumpel_openrouter_get_authorization",
    "GET",
    "/v1/openrouter-connection/authorizations/{openRouterAuthorizationId}",
    OpenRouterAuthorizationPathSchema,
    "Read one OpenRouter authorization you started. Returns the authorization; status.state is AwaitingCallback with authorizeUrl, Exchanging while the control plane spends the code, Completed with the keyLabel the key OPENROUTER_API_KEY carries on OpenRouter, or Failed with reason AuthorizationTimedOut, NotConnected, CodeRefused, ExchangeFailed or KeyNotStored and a detail naming the fix. It never carries the key.",
  ),
  rest(
    "tumpel_prebuild_get",
    "GET",
    "/v1/prebuilds/{prebuildId}",
    PrebuildPathSchema,
    "Read one prebuild; status.state is Dispatched, Building, Converting, Done with the layer, or Failed with the phase.",
  ),
  rest(
    "tumpel_prebuild_failure",
    "GET",
    "/v1/prebuilds/{prebuildId}/failure",
    PrebuildPathSchema,
    "Read why a Failed prebuild failed. Returns {phase, detail, fix}.",
  ),
  rest(
    "tumpel_prebuild_preview",
    "POST",
    "/v1/prebuilds/preview",
    PrebuildPreviewOfSuppliedSchema.extend({
      source: PrebuildPreviewSourceSchema,
      repository: PrebuildPreviewOfSuppliedSchema.shape.repository.describe(REPOSITORY_FORMAT),
      devcontainer: PrebuildPreviewOfSuppliedSchema.shape.devcontainer.optional(),
    }),
    "Show what a prebuild of a repository's default branch would run, without starting one: the commands in run order, containerEnv, the input digest and findings, each a problem a build would refuse or fail on with its fix. source RepositoryFile reads the repository's devcontainer.json; source Supplied reads devcontainer, the text of a devcontainer.json such as a template's, as if the repository held it. Refused DevcontainerMissing, naming the templates, when the repository holds no devcontainer.json and none is supplied.",
  ),
  rest(
    "tumpel_prebuild_template_list",
    "GET",
    "/v1/prebuild-templates",
    NO_ARGUMENTS,
    "List the devcontainer.json templates a prebuild can start from, such as npm, rust and python, each with its versions newest first, what each version installs and the toolchain versions it pins.",
  ),
  rest(
    "tumpel_prebuild_template_get",
    "GET",
    "/v1/prebuild-templates/{prebuildTemplateId}/versions/{prebuildTemplateVersion}",
    PrebuildTemplateVersionPathSchema,
    "Read one template version with its devcontainer.json text and the sha256 of that text. Refused PrebuildTemplateNotFound, listing the valid ids or versions.",
  ),
  rest(
    "tumpel_prebuild_template_open_pull_request",
    "POST",
    "/v1/prebuild-templates/pull-request",
    PrebuildTemplatePullRequestOpenSchema.extend({
      repository: PrebuildTemplatePullRequestOpenSchema.shape.repository.describe(REPOSITORY_FORMAT),
    }),
    "Open a pull request, through the tenant's GitHub App installation, that adds a template version as .devcontainer/devcontainer.json on the branch tumpel/prebuild-template; an open pull request from that branch is updated and returned. Refused DevcontainerExists, naming the file, when the repository already holds a devcontainer.json and replace is false; with replace true the pull request replaces it. Returns the pull request's url, number and state.",
  ),
  rest(
    "tumpel_prebuild_template_get_pull_request",
    "GET",
    "/v1/prebuild-templates/pull-request",
    PrebuildTemplatePullRequestQuerySchema.extend({
      repository: PrebuildTemplatePullRequestQuerySchema.shape.repository.describe(REPOSITORY_FORMAT),
    }),
    "Read the newest pull request from a repository's branch tumpel/prebuild-template: its url, number and state Open, Merged or Closed. Once it reads Merged, preview or start the prebuild. Refused NotFound when the branch has no pull request.",
  ),
  rest(
    "tumpel_secret_set_list",
    "GET",
    "/v1/secret-sets",
    NO_ARGUMENTS,
    "List the tenant's secret sets with their member names and kinds; values are write-only and never returned.",
  ),
  rest(
    "tumpel_secret_set_get",
    "GET",
    "/v1/secret-sets/{secretSetId}",
    SecretSetPathSchema,
    "Read one secret set with its member names and kinds; values are write-only and never returned.",
  ),
  {
    name: "tumpel_secret_set_update",
    description: `Draft the replacement of an existing secret set's name and members, by member name; the set must exist. ${KEY_NAMES_RULE}`,
    input: SecretSetPathSchema.extend(KEY_NAMES_ONLY.shape).strict(),
    request: { method: "GET", path: "/v1/secret-sets/{secretSetId}" },
    answer: "configSecretSet",
  },
  rest(
    "tumpel_secret_set_patch",
    "PATCH",
    "/v1/secret-sets/{secretSetId}",
    PATCH_WITHOUT_VALUES,
    "Rename a secret set, or rename members and change their provider or expiresAt, without values: each member you list keeps the value stored under its previousName, or under its name when you do not rename it. Every member you leave out keeps its value. Secret values never pass through MCP; tumpel_secret_set_set_member drafts the command that writes a new value.",
  ),
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
    "Delete one member of a secret set and its stored value; every other member keeps its value.",
  ),
  rest(
    "tumpel_secret_set_delete",
    "DELETE",
    "/v1/secret-sets/{secretSetId}",
    SecretSetPathSchema,
    "Delete a secret set and its stored values; refused while a persona names it.",
  ),
  rest(
    "tumpel_session_start",
    "POST",
    "/v1/sessions",
    SessionStartSchema.extend({ repository: SessionStartSchema.shape.repository.describe(REPOSITORY_FORMAT) }),
    "Start a session with its first prompt on the online host of the tenant least busy across box slots, load and memory; when no host has room, it first evicts the least recently used idle boxes kept by Auto sessions, and is refused PoolExhausted when no host has memory for the persona's box even then, or, on a host that reports no memory budget, when it runs or keeps a box in every slot; it runs its persona's harness at the pinned version, with the persona's files and secret set. A model that tumpel_harness_list does not list for the credential the turn uses is refused ModelUnsupported, before any box boots. boxRetention, Off, Warm or Auto, decides what happens to the session's box after each turn and defaults to the persona's. tags, up to 16, group the session for tumpel_session_list. Returns {session, turn}. The turn is Offered: accepted, not started or confirmed. Check back later with tumpel_turn_get for Running, Completed or Failed. For a long job that needs many sessions, give a session a goal and a subscription with tumpel_subscription_create.",
  ),
  rest(
    "tumpel_session_start_from_issue",
    "POST",
    "/v1/sessions/from-issue",
    SessionStartFromIssueSchema,
    "Start a session from an open issue of a GitHub repository, as tumpel_session_start does, with a first prompt the control plane writes from the issue: work the issue on the branch ticket/<issueNumber>-<slug>, push it and open a draft pull request that closes the issue. Pass the owner and name tumpel_github_list_repositories prints. Returns the session and its first turn; issue names the issue and the branch. The turn is Offered: accepted, not started or confirmed. Check back later with tumpel_turn_get for Running, Completed or Failed. Refused IssueNotFound for a missing issue and IssueNotOpen for a closed one or a pull request. For a long job that needs many sessions, give a session a goal and a subscription with tumpel_subscription_create.",
  ),
  rest(
    "tumpel_session_list",
    "GET",
    "/v1/sessions",
    PagedSessionListQuerySchema,
    "List the tenant's sessions, optionally only those in one state, on one host, carrying every tag in tag, started by the trigger triggerId, or whose latest turn last changed state at or before lastTurnBefore (an ISO 8601 time with offset). Sessions come oldest first; with limit (1 to 50) it returns at most limit of them, and after set to the last sessionId of a page reads the next. A page shorter than limit is the last.",
  ),
  rest(
    "tumpel_session_get",
    "GET",
    "/v1/sessions/{sessionId}",
    SessionPathSchema,
    "Read one session; state is Starting, Idle, Running, Stopping, Stopped, Failed or Archived. A Failed session could not clone its repository and takes no more turns.",
  ),
  {
    name: "tumpel_session_stop",
    description:
      "Stop a session: its host snapshots it and frees its box, and the next tumpel_turn_send boots a fresh box from the snapshots. Returns the session, Stopping until the box is gone and then Stopped. Refused TurnInFlight while a turn runs or waits, unless cancelTurn is true: the running turn then ends at once, it and every waiting turn fail Cancelled, and the box is snapshotted and freed. Refused while the host is offline.",
    input: SessionPathSchema.extend(SessionStopQuerySchema.shape),
    request: { method: "POST", path: "/v1/sessions/{sessionId}/stop", query: ["cancelTurn"] },
    answer: "rest",
  },
  rest(
    "tumpel_session_archive",
    "POST",
    "/v1/sessions/{sessionId}/archive",
    SessionPathSchema,
    "Archive an Idle, Stopped or Failed session: discard an Idle session's box without a snapshot, delete its snapshots, keep its transcript readable and refuse every later send. Final; archiving an Archived session returns it as it is. Refused while a turn runs or the session stops, and while an Idle session's host is offline. Returns the archived session.",
  ),
  rest(
    "tumpel_subscription_create",
    "POST",
    "/v1/subscriptions",
    SubscriptionCreateSchema,
    "Give a session a subscription for a long job: prompt is the plan, goal the condition that ends the work, events the session event types to react to, crewTags the tags a session must carry to count as its crew, and expiresAt (an ISO 8601 time with offset) the time it ends at the latest. Each matching event of a crew session becomes a new turn of the session, with the plan, the events and the goal; sessions that this session starts inherit the crew tags. Only a person creates one: a call from inside a tumpel session is refused, so an agent in a box tells its person instead. Returns the Active subscription.",
  ),
  rest(
    "tumpel_subscription_list",
    "GET",
    "/v1/subscriptions",
    SubscriptionListQuerySchema,
    "List the tenant's subscriptions, optionally only those of one session or in one state: Active, Paused or Ended.",
  ),
  rest(
    "tumpel_subscription_get",
    "GET",
    "/v1/subscriptions/{subscriptionId}",
    SubscriptionPathSchema,
    "Read one subscription with its state, the reason it paused or ended, its cursor and its failure counts in a row.",
  ),
  rest(
    "tumpel_subscription_pause",
    "POST",
    "/v1/subscriptions/{subscriptionId}/pause",
    SubscriptionPathSchema.extend(SubscriptionPauseSchema.shape),
    "Pause a subscription with a short message of up to 500 characters that reaches the person, for example when the session needs a decision. Events keep collecting and arrive after a resume. A person, or the subscribed session itself from inside its box, can pause it. Returns the Paused subscription.",
  ),
  rest(
    "tumpel_subscription_resume",
    "POST",
    "/v1/subscriptions/{subscriptionId}/resume",
    SubscriptionPathSchema,
    "Resume a Paused subscription: it becomes Active, its failure counts start over and the events after its cursor arrive in the next turn. Send a reply with tumpel_turn_send first when it paused with a question. Only a person resumes one. Refused when it paused so long that its events left the event log; delete it and create a new one then.",
  ),
  rest(
    "tumpel_subscription_delete",
    "DELETE",
    "/v1/subscriptions/{subscriptionId}",
    SubscriptionPathSchema,
    "Delete a subscription and cancel its waiting turn. A person, or the subscribed session itself from inside its box, can delete it.",
  ),
  rest(
    "tumpel_subscription_complete",
    "POST",
    "/v1/subscriptions/{subscriptionId}/complete",
    SubscriptionPathSchema,
    "End a subscription because its goal holds: it ends with reason GoalMet, its waiting turn is cancelled and the person is told. The subscribed session calls it from inside its box once the goal holds; a person can call it too. Returns the Ended subscription.",
  ),
  rest(
    "tumpel_trigger_create",
    "POST",
    "/v1/triggers",
    TriggerCreateSchema,
    "Create a trigger that starts a fresh session whenever a GitHub event of one type arrives through the stage's GitHub App and every condition holds on its payload. source is {kind: GitHub, event, conditions}: event is pull_request, pull_request_review, push, status, check_suite or issues; each condition names a dotted field path into the webhook payload, such as pull_request.base.ref, label.name or sender.login, and the values it may equal, compared as JSON text, so true matches a boolean; a path through an array matches any element. The session runs on personaId with model, on the event's repository, with prompt as its first prompt, where each {{field}} placeholder is filled from the payload. Every session runs as you. Tumpel only listens: tell the session in the prompt how to report back, such as with a review or a commit status. Test it first with tumpel_trigger_test. Only an Owner creates a trigger that starts sessions. With sessionId set, the trigger instead sends that existing session one turn with the filled prompt and then deletes itself; personaId and model must be the session's. A session may create such a trigger targeting itself, at most 10 per session and 50 per tenant.",
  ),
  rest(
    "tumpel_trigger_list",
    "GET",
    "/v1/triggers",
    NO_ARGUMENTS,
    "List the tenant's triggers; a targeted one carries the sessionId it wakes.",
  ),
  rest("tumpel_trigger_get", "GET", "/v1/triggers/{triggerId}", TriggerPathSchema, "Read one trigger."),
  rest(
    "tumpel_trigger_update",
    "PATCH",
    "/v1/triggers/{triggerId}",
    TriggerPathSchema.extend(TriggerPatchSchema.shape),
    "Change the fields of a trigger you name and keep the rest; a named source replaces the whole source, its event and conditions included. Its sessions then run as you. Only an Owner, outside a tumpel box, changes one.",
  ),
  rest(
    "tumpel_trigger_delete",
    "DELETE",
    "/v1/triggers/{triggerId}",
    TriggerPathSchema,
    "Delete a trigger; the sessions it started stay. Only an Owner, outside a tumpel box, deletes one, except that a session may delete a trigger targeting itself.",
  ),
  rest(
    "tumpel_trigger_test",
    "POST",
    "/v1/triggers/test",
    TRIGGER_TEST,
    "Match a trigger against a sample webhook payload, such as one from the recent deliveries in the GitHub App's settings, without starting anything. kind Stored tests the trigger triggerId; kind Draft tests trigger, the fields tumpel_trigger_create takes, before it exists. Returns matched, each condition with the values the payload holds at its field and whether it holds, the prompt the session would get, and missingFields, the placeholders the payload lacks, which would refuse a start.",
  ),
  rest(
    "tumpel_session_set_tags",
    "PUT",
    "/v1/sessions/{sessionId}/tags",
    SessionPathSchema.extend(SessionTagsSchema.shape),
    "Replace every tag of a session with tags, up to 16, each lower-case letters, digits and :._- of at most 63 characters. Returns the session. Refused for an archived session.",
  ),
  rest(
    "tumpel_session_patch_tags",
    "PATCH",
    "/v1/sessions/{sessionId}/tags",
    SessionPathSchema.extend(SessionTagsPatchSchema.shape),
    "Remove the tags in remove and add the tags in add; every other tag of the session stays. Returns the session. Refused when the session would carry more than 16 tags, and for an archived session.",
  ),
  rest(
    "tumpel_session_delete",
    "DELETE",
    "/v1/sessions/{sessionId}",
    SessionPathSchema,
    "Delete an Idle, Stopped, Failed or Archived session for good: its turns, transcript and snapshots. A snapshot chunk or prebuild layer another session or a prebuild still holds stays. Refused while a turn runs or the session stops, and while an Idle session's host is offline.",
  ),
  rest(
    "tumpel_session_stop_failures",
    "GET",
    "/v1/sessions/{sessionId}/stop-failures",
    SessionPathSchema,
    "List the stops of a session that failed, oldest first; each returned the session to Idle with its box kept. Returns {reason, detail, failedAt}.",
  ),
  rest(
    "tumpel_turn_send",
    "POST",
    "/v1/sessions/{sessionId}/turns",
    SessionPathSchema.extend(TurnSendSchema.shape),
    "Send a session its next prompt. Pass goal to name when the work is done: the harness keeps working toward it until it holds. Only a harness that tumpel_harness_list shows with goals true takes a goal. Returns the turn, with its goal; the turn is Offered: accepted, not started or confirmed. Check back later with tumpel_turn_get for Running, Completed or Failed. A turn sent while another turn of the session is in flight waits Offered, and the waiting turns start in send order, each when the turn before it ends; its time budget starts when it starts.",
  ),
  rest(
    "tumpel_turn_list",
    "GET",
    "/v1/sessions/{sessionId}/turns",
    SessionPathSchema,
    "List a session's turns, oldest first.",
  ),
  rest(
    "tumpel_turn_get",
    "GET",
    "/v1/turns/{turnId}",
    TurnPathSchema,
    "Read one turn; state is Offered, Running, Completed or Failed.",
  ),
  rest(
    "tumpel_events_list",
    "GET",
    "/v1/events",
    EventQuerySchema,
    "Read the tenant's events after afterEventId, such as TurnCompleted, TurnFailed, SessionIdle or PrebuildDone, or follow GET /v1/events over a WebSocket. Reads from the end of the log when afterEventId is left out. Filter with event (repeatable) and sessionId. Returns {events, lastEventId}; pass lastEventId as afterEventId on the next call so no event is missed. Refused EventCursorExpired when afterEventId is older than the 7 days the log keeps.",
  ),
  rest(
    "tumpel_turn_cancel",
    "POST",
    "/v1/turns/{turnId}/cancel",
    TurnPathSchema,
    "Cancel a turn that waits Offered behind another turn of its session and has not started: it fails Cancelled, naming you in its failure detail, and the turns behind it keep their order. Returns the turn. Refused TurnNotWaiting once the turn started or ended; tumpel_session_stop with cancelTurn true ends a running turn.",
  ),
  rest(
    "tumpel_turn_steer",
    "POST",
    "/v1/turns/{turnId}/steers",
    TurnPathSchema.extend(SteerCreateSchema.shape),
    "Send a prompt to a Running turn: the harness reads it after its next tool call, or before it ends the turn, and keeps working inside the same turn. Returns the steer, Pending. Refused TurnNotRunning once the turn ended, and SteerUnsupported when the turn's box reads no steer: only a Claude Code turn on a host that runs connectors takes one. Send a follow-up turn instead then.",
  ),
  rest(
    "tumpel_turn_list_steers",
    "GET",
    "/v1/turns/{turnId}/steers",
    TurnPathSchema,
    "List a turn's steers, oldest first, each Pending, Delivered when the harness took it, or TurnEnded when the turn ended first.",
  ),
  rest(
    "tumpel_turn_failure",
    "GET",
    "/v1/turns/{turnId}/failure",
    TurnPathSchema,
    "Read why a Failed turn failed. Returns {reason, detail}.",
  ),
  {
    name: "tumpel_transcript_read",
    description:
      "Read a page of a session's harness-native JSONL transcript; turnId keeps one turn's lines, limit and maxBytes cap the page (by default the transcript chunk size, no line cap with compact, and 32768 bytes). Pass compact true to poll a live turn of a harness that tumpel_harness_list shows with compactTranscript true: it keeps the text the assistant wrote, shows each tool call as one line naming the tool and its first argument, keeps one line per token, cost or error report, drops tool results, and names the session once and each turn once above its lines. Pass the cursor of the previous page as after to read on; finished is true when no turn is in flight and no line follows. Returns {form: Raw, sessionState, lines, cursor, finished}, or with compact {form: Compact, sessionId, sessionState, turns, cursor, finished}.",
    input: SessionPathSchema.extend(TranscriptQuerySchema.shape),
    request: { method: "GET", path: "/v1/sessions/{sessionId}/transcript" },
    answer: "rest",
  },
  rest(
    "tumpel_session_handovers",
    "GET",
    "/v1/sessions/{sessionId}/credential-handovers",
    SessionPathSchema,
    "List the credential handovers of a session, oldest first: the variable names each turn offer carried, never their values.",
  ),
  rest(
    "tumpel_snapshot_list",
    "GET",
    "/v1/sessions/{sessionId}/snapshots",
    SessionPathSchema,
    "List a session's snapshots in order, each stored or failed with its reason.",
  ),
  rest(
    "tumpel_snapshot_get",
    "GET",
    "/v1/snapshots/{snapshotId}",
    SnapshotPathSchema,
    "Read one snapshot: its stored size, or why it was not stored.",
  ),
  rest(
    "tumpel_metrics_catalog",
    "GET",
    "/v1/metrics",
    MetricWindowSchema,
    "List every metric with series seen between from and to (ISO 8601 with an offset), each with its unit, kind and its dimensions with their values and series counts. filter takes dimension:value entries; one dimension repeated is OR, different dimensions AND. Returns {metrics: [{metric, unit, kind, description, facets}], usage: {tier, counters: [{measure, window, used, limit, resetsAt}]}}, where usage is the tenant's use of each of its limits in the current windows.",
  ),
  rest(
    "tumpel_metrics_query",
    "GET",
    "/v1/metrics/{metric}/series",
    MetricPathSchema.extend(MetricSeriesQuerySchema.shape),
    "Read a metric's buckets between from and to: bucket is Minute, Hour or Day (Day starts at midnight in the offset of from). groupBy takes up to two dimensions; past 20 groups the rest fold into one group whose values read Other. filter takes dimension:value entries as in tumpel_metrics_catalog. Each point has bucketStart, count, sum, min, max, p50, p90 and p99. Refused MetricRangeTooLarge past 500 buckets or for Minute buckets older than 8 days, naming a range that fits.",
  ),
  rest(
    "tumpel_metrics_turns",
    "GET",
    "/v1/metrics/{metric}/turns",
    MetricPathSchema.extend(MetricTurnQuerySchema.shape),
    "List the turn points behind a Turn metric between from and to, oldest first, each with its turnId, sessionId, value and dimensions; sessionId keeps one session's points. Pass the cursor of the previous page to read on; finished is true when no point follows.",
  ),
];

const PATH_KEY = /\{(\w+)\}/g;

const pathKeys = (path: string): string[] => [...path.matchAll(PATH_KEY)].map((match) => match[1] ?? "");

const toolRequest = (
  tool: ToolDefinition,
  request: { method: Method; path: string; query?: string[] },
  args: Record<string, unknown>,
  origin: string,
): Request => {
  const keys = pathKeys(request.path);
  const path = request.path.replace(PATH_KEY, (_, key: string) => encodeURIComponent(String(args[key])));
  const carriesBody = tool.answer === "rest" && ["POST", "PUT", "PATCH"].includes(request.method);
  const rest = Object.entries(args).filter(([key]) => !keys.includes(key));
  const queried = (key: string): boolean => request.method === "GET" || (request.query ?? []).includes(key);
  const body = Object.fromEntries(rest.filter(([key]) => !queried(key)));
  const params = rest.filter(([key]) => queried(key));
  const query =
    params.length > 0
      ? `?${new URLSearchParams(
          params.flatMap(([key, value]) =>
            Array.isArray(value) ? value.map((entry) => [key, String(entry)]) : [[key, String(value)]],
          ),
        )}`
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
  return `${problem.data.code}: ${problem.data.title}: ${problem.data.detail}. ${problem.data.fix}`;
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
      return { ok: true, text: text || (DONE[tool.name] ?? "Done") };
    }
  }
  if (tool.answer === "connectorTokenCommand") {
    return { ok: true, text: connectorTokenCommand(ConnectorPathSchema.parse(args)) };
  }
  if (tool.answer === "memberCommand") return { ok: true, text: memberCommand(MEMBER_WITHOUT_VALUE.parse(args)) };
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
    inputSchema: { type: "object", ...z.toJSONSchema(tool.input) },
  })),
});

const toolReply = (id: Id, outcome: ToolResult): Response => {
  const text = outcome.ok ? outcome.text : outcome.error;
  return reply(id, { content: [{ type: "text", text }], ...(outcome.ok ? {} : { isError: true }) });
};

const toolFailed = (id: Id, tool: ToolDefinition, error: unknown): Response => {
  console.error(`MCP tool ${tool.name} failed inside the control plane`, error);
  const reason = error instanceof Error ? error.message : String(error);
  return refuse(
    id,
    INTERNAL_ERROR,
    `${tool.name} failed inside the control plane: ${reason}; report the tool name and this message to the operator`,
    200,
  );
};

const callResult = async (id: Id, params: unknown, run: Bound): Promise<Response> => {
  if (!isRecord(params)) return refuse(id, INVALID_PARAMS, "tools/call takes {name, arguments}", 200);
  const tool = toolNamed(params.name);
  if (tool === undefined) return refuse(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`, 200);
  const args = params.arguments;
  if (args !== undefined && !isRecord(args)) {
    return refuse(id, INVALID_PARAMS, `${tool.name} takes its arguments as a JSON object`, 200);
  }
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    return toolReply(id, { ok: false, error: `${tool.name} refused its arguments: ${issues(parsed.error)}` });
  }
  return runTool(tool, parsed.data, run.dispatch, run.origin).then(
    (outcome) => toolReply(id, outcome),
    (error: unknown) => toolFailed(id, tool, error),
  );
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
  const bounded = await readBoundedJson(request);
  if (!bounded.ok) return refuse(null, INVALID_REQUEST, bounded.detail, 400);
  const body = bounded.value;
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
