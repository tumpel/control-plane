#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OPENAPI = join(ROOT, "packages/api/generated/openapi.json");
const MCP = join(ROOT, "packages/control-plane/src/mcp.ts");
const CLI = join(ROOT, "crates/tumpel/src/main.rs");
const DOC = join(ROOT, "doc/surface.md");

const NOUNS = {
  Identity: "",
  Devices: "devices",
  Members: "member",
  Invitations: "invitation",
  EnrolmentTokens: "host",
  Hosts: "host",
  HarnessCatalog: "harness",
  Releases: "release",
  Personas: "persona",
  SecretSets: "secret-set",
  GitHubConnections: "github",
  Sessions: "session",
  Turns: "turn",
  Transcripts: "transcript",
  Snapshots: "snapshot",
  Prebuilds: "prebuild",
  Connections: "connection",
  GitHubActionsConnections: "github-actions",
  CircleCIConnections: "circleci",
  CircleCIProjects: "circleci project",
  NamespaceConnections: "namespace",
  TenantConfigs: "config",
  OAuthGrants: "oauth-grant",
  ClaudeSetups: "claude-setup",
  OpenRouterConnections: "openrouter",
};
const VERBS = {
  Identity_listTenants: "tenants",
  EnrolmentTokens_mint: "mint-token",
  EnrolmentTokens_list: "list-tokens",
  EnrolmentTokens_revoke: "revoke-token",
  Turns_getFailure: "failure",
  Sessions_listCredentialHandovers: "handovers",
  Sessions_listStopFailures: "stop-failures",
  Prebuilds_getFailure: "failure",
};
const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const namesFor = (operationId) => {
  const [group, op = ""] = operationId.split("_");
  const parts = [NOUNS[group] ?? kebab(group), VERBS[operationId] ?? kebab(op)].filter(Boolean);
  return { tool: `tumpel_${parts.join("_").replaceAll(/[- ]/g, "_")}`, command: `tumpel ${parts.join(" ")}` };
};

const operations = () => {
  const spec = JSON.parse(readFileSync(OPENAPI, "utf8"));
  return Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([, operation]) => operation.operationId)
      .map(([method, operation]) => ({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        path,
        security: operation.security ?? spec.security ?? [],
      })),
  );
};

const BROWSER_ONLY = "browser-only page behind the identity-aware proxy, signed in by its assertion";
const OAUTH_WIRE = "OAuth wire a client signs in with before it holds a token";
const DISCOVERY = "OAuth and OpenID discovery document a client reads before it signs in";
const DEVICE_WIRE = "device-code wire the CLI signs in with before it holds a token";
const RELEASE_DOWNLOAD = "release download the installer and the supervisor fetch without sign-in";
const BUILD_JOB = "build job wire, signed by the provider's OIDC job token, never by a principal";

const ALLOWLIST = {
  DeviceFlow_approve: BROWSER_ONLY,
  DeviceFlow_deny: BROWSER_ONLY,
  Invitations_accept: BROWSER_ONLY,
  Tenants_signUp: BROWSER_ONLY,
  WellKnown_jwks: DISCOVERY,
  WellKnown_authorizationServer: DISCOVERY,
  WellKnown_authorizationServerForMcp: DISCOVERY,
  WellKnown_protectedResource: DISCOVERY,
  WellKnown_protectedResourceForMcp: DISCOVERY,
  WellKnown_openIdConfiguration: DISCOVERY,
  OAuth_authorize: OAUTH_WIRE,
  OAuth_register: OAUTH_WIRE,
  OAuth_revoke: OAUTH_WIRE,
  OAuth_token: OAUTH_WIRE,
  DeviceFlow_start: DEVICE_WIRE,
  DeviceFlow_token: DEVICE_WIRE,
  health: "liveness probe of the control plane, no principal",
  Hosts_enrol: "host channel: the supervisor trades its one-time enrolment token for the host's identity",
  Releases_cli: RELEASE_DOWNLOAD,
  Releases_supervisor: RELEASE_DOWNLOAD,
  Releases_install: "install script a person pipes to sh before the CLI exists",
  PrebuildUploads_start: BUILD_JOB,
  PrebuildUploads_complete: BUILD_JOB,
  PrebuildInputs_read: BUILD_JOB,
  CircleCIEvents_receive: "provider webhook, signed with the project binding's secret, never by a principal",
  ClaudeSetupBoxes_writeToken: "setup box wire, signed by the box's single-use token, never by a principal",
};

const CLI_ONLY = {
  ClaudeSetups_submitCode:
    "takes the one-time Claude sign-in code, a secret value, which never passes through MCP; the dashboard and tumpel claude-setup submit-code --stdin take it",
  CircleCIConnections_complete:
    "takes the redirect address that carries CircleCI's one-time authorization code, which never passes through MCP; the dashboard, tumpel circleci authorize and tumpel circleci complete --stdin take it",
};

const tools = () => new Set([...readFileSync(MCP, "utf8").matchAll(/"(tumpel_[a-z_]+)"/g)].map((match) => match[1]));

const commands = () => {
  const source = readFileSync(CLI, "utf8");
  const enums = new Map();
  for (const [, name, body] of source.matchAll(/#\[derive\(Subcommand\)\]\s*enum (\w+) \{([\s\S]*?)\n\}/g)) {
    enums.set(
      name,
      [...body.matchAll(/^ {4}([A-Z]\w*)\s*(?:\{([\s\S]*?)^ {4}\}|,)/gm)].map(([, variant, fields]) => ({
        name: kebab(variant),
        nested: fields?.match(/command: (\w+)/)?.[1],
      })),
    );
  }
  const expand = (prefix, enumName) =>
    (enums.get(enumName) ?? []).flatMap(({ name, nested }) =>
      nested ? [`${prefix} ${name}`, ...expand(`${prefix} ${name}`, nested)] : [`${prefix} ${name}`],
    );
  return new Set(expand("tumpel", "Command"));
};

const table = ([header, ...body]) => {
  const widths = header.map((_, column) => Math.max(...[header, ...body].map((row) => row[column].length)));
  const line = (cells) => `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)];
};

const render = (rows) =>
  [
    "# Public surface",
    "",
    "Every tenant operation is one MCP tool and one CLI command, backed by the same REST handler, so an",
    "MCP session sets up and runs a whole tenant. `npm run surface` writes this file; `npm run surface:check`",
    "fails when an operation lacks a tool or a command and is not on the allowlist, when an allowlist entry",
    "names no operation or one that has a tool, or when this file is stale.",
    "",
    "Naming: an operation `Group_op` is the tool `tumpel_<noun>_<verb>` and the command",
    "`tumpel <noun> <verb>`, where the verb is `op` in kebab-case and the noun comes from the group:",
    `${Object.entries(NOUNS)
      .map(([group, noun]) => `${group} \`${noun || "(none)"}\``)
      .join(", ")}.`,
    "`EnrolmentTokens_mint`, `_list` and `_revoke` take the verbs `mint-token`, `list-tokens` and `revoke-token`,",
    "`Turns_getFailure` and `Prebuilds_getFailure` the verb `failure`,",
    "`Sessions_listCredentialHandovers` the verb `handovers` and `Sessions_listStopFailures` the verb",
    "`stop-failures`. `Releases_current` needs no sign-in over REST and is listed because a signed-in",
    "principal reads it too. The CLI's `transcript read` takes a turnId and reads that turn's lines of its",
    "session; `session get` also prints the session's stop failures.",
    "",
    "`tumpel_secret_set_create` and `_update` take key names and `valueFrom.env` names only and write",
    "nothing: the server cannot read your environment, so they return the config entry for",
    "`tumpel config apply`, which writes the values.",
    "",
    "`tumpel_secret_set_set_member` returns the `tumpel secret-set set-member` command that writes one member; see [Set one value at a time](config.md#set-one-value-at-a-time).",
    "",
    ...table([
      ["Operation", "MCP tool", "CLI command"],
      ...rows.map((row) =>
        [row.operationId, row.operationId in CLI_ONLY ? "(none)" : row.tool, row.command].map((cell) => `\`${cell}\``),
      ),
    ]),
    "",
    "CLI only: tenant operations with a CLI command and no MCP tool:",
    "",
    ...Object.entries(CLI_ONLY).map(([operationId, reason]) => `- \`${operationId}\`: ${reason}.`),
    "",
    "Allowlist: operations that are not tenant operations, with no tool or command:",
    "",
    ...Object.entries(ALLOWLIST).map(([operationId, reason]) => `- \`${operationId}\`: ${reason}.`),
    "",
  ].join("\n");

const all = operations();
const rows = all
  .filter((op) => !(op.operationId in ALLOWLIST))
  .map((op) => ({ ...op, ...namesFor(op.operationId) }))
  .sort((a, b) => a.operationId.localeCompare(b.operationId));

const toolNames = tools();
const commandNames = commands();
const failures = [
  ...Object.keys(ALLOWLIST)
    .filter((operationId) => !all.some((op) => op.operationId === operationId))
    .map((operationId) => `the allowlist names ${operationId}, which is no operation`),
  ...Object.keys(ALLOWLIST)
    .filter((operationId) => toolNames.has(namesFor(operationId).tool))
    .map((operationId) => `${operationId} has the MCP tool ${namesFor(operationId).tool} and must leave the allowlist`),
  ...Object.keys(CLI_ONLY)
    .filter((operationId) => !all.some((op) => op.operationId === operationId))
    .map((operationId) => `the CLI-only list names ${operationId}, which is no operation`),
  ...Object.keys(CLI_ONLY)
    .filter((operationId) => toolNames.has(namesFor(operationId).tool))
    .map(
      (operationId) => `${operationId} has the MCP tool ${namesFor(operationId).tool} and must leave the CLI-only list`,
    ),
  ...rows
    .filter((row) => !(row.operationId in CLI_ONLY) && !toolNames.has(row.tool))
    .map((row) => `${row.operationId} has no MCP tool ${row.tool}`),
  ...rows
    .filter((row) => !commandNames.has(row.command))
    .map((row) => `${row.operationId} has no CLI command ${row.command}`),
  ...[...toolNames]
    .filter((tool) => !rows.some((row) => row.tool === tool))
    .map((tool) => `the MCP tool ${tool} names no operation`),
];

const document = render(rows);
if (process.argv.includes("--write")) writeFileSync(DOC, document);
const current = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";
if (current !== document) failures.push("doc/surface.md is stale; run npm run surface and commit it");

if (failures.length > 0) {
  console.error(`surface check failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `surface: ${rows.length} operations each have a CLI command and all but ${Object.keys(CLI_ONLY).length} an MCP tool; ${Object.keys(ALLOWLIST).length} allowlisted`,
);
