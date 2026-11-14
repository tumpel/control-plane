#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OPENAPI = join(ROOT, "packages/api/generated/openapi.json");
const MCP = join(ROOT, "packages/control-plane/src/mcp.ts");
const SRC = join(ROOT, "packages/control-plane/src");
const CLI = join(ROOT, "crates/tumpel/src/main.rs");
const DOC = join(ROOT, "doc/surface.md");

const NOUNS = {
  Identity: "",
  Devices: "devices",
  EnrolmentTokens: "host",
  Hosts: "host",
  HarnessCatalog: "harness",
  Personas: "persona",
  SecretSets: "secret-set",
  Sessions: "session",
  Turns: "turn",
  Transcripts: "transcript",
  Snapshots: "snapshot",
};
const VERBS = {
  EnrolmentTokens_mint: "mint-token",
  Turns_getFailure: "failure",
  Sessions_listCredentialHandovers: "handovers",
  Sessions_listStopFailures: "stop-failures",
};
const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const namesFor = (operationId) => {
  const [group, op] = operationId.split("_");
  const parts = [NOUNS[group] ?? kebab(group), VERBS[operationId] ?? kebab(op)].filter(Boolean);
  return { tool: `tumpel_${parts.join("_").replaceAll("-", "_")}`, command: `tumpel ${parts.join(" ")}` };
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

const served = readdirSync(SRC, { recursive: true })
  .filter((file) => String(file).endsWith(".ts"))
  .map((file) => readFileSync(join(SRC, String(file)), "utf8"))
  .join("\n");

const RULES = [
  {
    rule: "browser-only: signed in by the identity assertion",
    matches: (op) => op.security.some((scheme) => "IdentityAssertion" in scheme),
  },
  {
    rule: "OAuth, device-flow and enrolment wire: no principal",
    matches: (op) => op.security.some((scheme) => Object.keys(scheme).length === 0),
  },
  {
    rule: "not served yet: no control-plane route",
    matches: (op) => !served.includes(op.path.split("/").slice(0, 3).join("/")),
  },
];

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
  return new Set(
    (enums.get("Command") ?? []).flatMap(({ name, nested }) =>
      nested ? (enums.get(nested) ?? []).map((sub) => `tumpel ${name} ${sub.name}`) : [`tumpel ${name}`],
    ),
  );
};

const table = ([header, ...body]) => {
  const widths = header.map((_, column) => Math.max(...[header, ...body].map((row) => row[column].length)));
  const line = (cells) => `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)];
};

const render = (rows, excluded) =>
  [
    "# Public surface",
    "",
    "Every operation a signed-in principal calls over REST is also one MCP tool and one CLI command,",
    "backed by the same REST handler. `npm run surface` writes this file; `npm run surface:check`",
    "fails when an operation lacks a tool or a command, or when this file is stale.",
    "",
    "Naming: an operation `Group_op` is the tool `tumpel_<noun>_<verb>` and the command",
    "`tumpel <noun> <verb>`, where the verb is `op` in kebab-case and the noun comes from the group:",
    `${Object.entries(NOUNS)
      .map(([group, noun]) => `${group} \`${noun || "(none)"}\``)
      .join(", ")}.`,
    "`EnrolmentTokens_mint` takes the verb `mint-token`, `Turns_getFailure` the verb `failure`,",
    "`Sessions_listCredentialHandovers` the verb `handovers` and `Sessions_listStopFailures` the verb",
    "`stop-failures`. The CLI's `transcript read` takes a turnId and reads that turn's lines of its",
    "session; `session get` also prints the session's stop failures.",
    "",
    "`tumpel_secret_set_create` and `_update` take key names and `valueFrom.env` names only and write",
    "nothing: the server cannot read your environment, so they return the config entry for",
    "`tumpel config apply`, which writes the values.",
    "",
    ...table([
      ["Operation", "MCP tool", "CLI command"],
      ...rows.map((row) => [row.operationId, row.tool, row.command].map((cell) => `\`${cell}\``)),
    ]),
    "",
    "Excluded by rule:",
    "",
    ...excluded
      .filter(({ ids }) => ids.length > 0)
      .map(({ rule, ids }) => `- ${rule}: ${ids.map((id) => `\`${id}\``).join(", ")}.`),
    "",
  ].join("\n");

const all = operations();
const ruleOf = (op) => RULES.find(({ matches }) => matches(op))?.rule;
const excluded = RULES.map(({ rule }) => ({
  rule,
  ids: all.filter((op) => ruleOf(op) === rule).map((op) => op.operationId),
}));
const excludedIds = new Set(excluded.flatMap(({ ids }) => ids));
const rows = all
  .filter((op) => !excludedIds.has(op.operationId))
  .map((op) => ({ ...op, ...namesFor(op.operationId) }))
  .sort((a, b) => a.operationId.localeCompare(b.operationId));

const toolNames = tools();
const commandNames = commands();
const failures = [
  ...rows.filter((row) => !toolNames.has(row.tool)).map((row) => `${row.operationId} has no MCP tool ${row.tool}`),
  ...rows
    .filter((row) => !commandNames.has(row.command))
    .map((row) => `${row.operationId} has no CLI command ${row.command}`),
  ...[...toolNames]
    .filter((tool) => !rows.some((row) => row.tool === tool))
    .map((tool) => `the MCP tool ${tool} names no operation`),
];

const document = render(rows, excluded);
if (process.argv.includes("--write")) writeFileSync(DOC, document);
const current = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";
if (current !== document) failures.push("doc/surface.md is stale; run npm run surface and commit it");

if (failures.length > 0) {
  console.error(`surface check failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `surface: ${rows.length} operations each have an MCP tool and a CLI command; ${excludedIds.size} excluded by rule`,
);
