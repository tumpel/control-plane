import assert from "node:assert/strict";
import { test } from "node:test";
import { describeFinding, readDevcontainer, resolveContainerEnv } from "../src/devcontainer.ts";

const PATH = ".devcontainer/devcontainer.json";

test("each unsupported field is a finding that names the field and its fix", () => {
  const { findings } = readDevcontainer(
    JSON.stringify({
      image: "node",
      build: {},
      dockerFile: "Dockerfile",
      dockerComposeFile: "compose.yml",
      features: { "ghcr.io/devcontainers/features/node:1": {} },
    }),
    PATH,
  );
  assert.deepEqual(
    findings.map((finding) => [finding.code, finding.field, finding.fix]),
    [
      ["PrebuildImageUnsupported", "image", "remove image"],
      ["PrebuildImageUnsupported", "build", "remove build"],
      ["PrebuildImageUnsupported", "dockerFile", "remove dockerFile"],
      ["PrebuildImageUnsupported", "dockerComposeFile", "remove dockerComposeFile"],
      ["PrebuildFeaturesUnsupported", "features", "remove features and install them from onCreateCommand instead"],
    ],
  );
  assert.deepEqual(findings.slice(0, 1).map(describeFinding), [
    "PrebuildImageUnsupported: .devcontainer/devcontainer.json names an image, and a prebuild builds on the tumpel guest image; remove image",
  ]);
});

test("empty features are no finding", () => {
  assert.deepEqual(readDevcontainer('{ "features": {} }', PATH).findings, []);
});

test("invalid JSON with comments is one finding naming the file", () => {
  const { findings, commands } = readDevcontainer('{ "onCreateCommand": "npm ci" ', PATH);
  assert.deepEqual(commands, []);
  assert.equal(findings.length, 1);
  assert.match(
    findings.map(describeFinding).join("\n"),
    /^DevcontainerInvalid: \.devcontainer\/devcontainer\.json is not JSON with comments \(.+\); fix the file$/,
  );
});

test("comments and trailing commas parse, and commas or slashes inside strings stay", () => {
  const { findings, commands } = readDevcontainer(
    `{
  // a line comment
  /* a block comment */
  "onCreateCommand": "echo 'a, ]' // not a comment",
}`,
    PATH,
  );
  assert.deepEqual(findings, []);
  assert.deepEqual(commands, [
    {
      lifecycle: "onCreateCommand",
      label: "onCreateCommand",
      file: "/bin/sh",
      args: ["-c", "echo 'a, ]' // not a comment"],
    },
  ]);
});

test("commands come in lifecycle order, object-form entries in key order", () => {
  const { commands } = readDevcontainer(
    JSON.stringify({
      postStartCommand: "start",
      postCreateCommand: { b: "second", a: ["echo", "third"] },
      onCreateCommand: ["npm", "ci"],
      updateContentCommand: "update",
    }),
    PATH,
  );
  assert.deepEqual(
    commands.map((command) => [command.label, command.file, ...command.args]),
    [
      ["onCreateCommand", "npm", "ci"],
      ["updateContentCommand", "/bin/sh", "-c", "update"],
      ["postCreateCommand.b", "/bin/sh", "-c", "second"],
      ["postCreateCommand.a", "echo", "third"],
      ["postStartCommand", "/bin/sh", "-c", "start"],
    ],
  );
});

test("a nested object command and a number command are findings", () => {
  const { findings } = readDevcontainer(
    JSON.stringify({ onCreateCommand: { a: { b: "x" } }, postCreateCommand: 3 }),
    PATH,
  );
  assert.deepEqual(
    findings.map((finding) => finding.detail),
    [
      "onCreateCommand.a in .devcontainer/devcontainer.json is neither a string nor an array",
      "postCreateCommand in .devcontainer/devcontainer.json is neither a string, an array nor an object",
    ],
  );
});

test("containerEnv references resolve against the base environment, then the fallback, then empty", () => {
  const { containerEnv } = readDevcontainer(
    `{
  "containerEnv": {
    "PATH": "\${containerEnv:PATH}:/extra",
    "MODE": "\${containerEnv:UNSET:dev}",
    "EMPTY": "[\${containerEnv:UNSET}]"
  }
}`,
    PATH,
  );
  assert.deepEqual(resolveContainerEnv({ PATH: "/usr/bin", HOME: "/root" }, containerEnv), {
    PATH: "/usr/bin:/extra",
    HOME: "/root",
    MODE: "dev",
    EMPTY: "[]",
  });
});
