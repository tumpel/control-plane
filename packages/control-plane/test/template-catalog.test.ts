import assert from "node:assert/strict";
import { test } from "node:test";
import { catalog, findVersion, type PrebuildTemplateVersion, recordProblems } from "../src/template-catalog.ts";

const GUEST = { Node: "26.13.1", Rust: "1.100.0", Python: "3.15.2" };
const NODE = [{ toolchain: "Node" as const, toolchainVersion: "26.13.1" }];

const version = (prebuildTemplateVersion: number): PrebuildTemplateVersion => ({
  prebuildTemplateId: "npm",
  prebuildTemplateVersion,
  summary: `npm ${prebuildTemplateVersion}`,
  installs: [],
  toolchains: NODE,
  digest: String(prebuildTemplateVersion).repeat(64),
  devcontainer: "{}",
});

test("a template lists its versions newest first, without their devcontainer text", () => {
  const [npm] = catalog([version(1), version(3), version(2)]);
  assert.deepEqual(
    npm?.versions.map((each) => each.prebuildTemplateVersion),
    [3, 2, 1],
  );
  assert.equal(
    npm?.versions.some((each) => "devcontainer" in each),
    false,
  );
});

test("an unknown template names the templates and an unknown version names the versions", () => {
  const shipped = [version(1), version(2), { ...version(1), prebuildTemplateId: "rust" }];
  assert.deepEqual(findVersion(shipped, "go", 1), {
    kind: "NotFound",
    detail: "no template is called go; the templates are npm, rust",
  });
  assert.deepEqual(findVersion(shipped, "npm", 7), {
    kind: "NotFound",
    detail: "template npm has no version 7; its versions are 2, 1",
  });
});

const recorded = (prebuildTemplateVersion: number, digest: string) => ({
  prebuildTemplateId: "npm",
  prebuildTemplateVersion,
  digest,
});

const onDisk = (prebuildTemplateVersion: number, digest: string, toolchains = NODE) => ({
  ...recorded(prebuildTemplateVersion, digest),
  toolchains,
});

test("the record refuses a changed digest, a removed version and an unrecorded one", () => {
  const problems = recordProblems(
    [recorded(1, "a".repeat(64)), recorded(2, "b".repeat(64))],
    [onDisk(1, "c".repeat(64)), onDisk(3, "d".repeat(64))],
    GUEST,
  );
  assert.equal(problems.length, 3);
  assert.match(problems[0] ?? "", /^npm\/1 changed: versions.json records a{64} and its devcontainer.jsonc is c{64}/);
  assert.match(problems[1] ?? "", /^npm\/2 is recorded in versions.json and missing from templates/);
  assert.match(problems[2] ?? "", /^npm\/3 is not in versions.json; record it with digest d{64}$/);
});

test("the record accepts a new version once it is recorded", () => {
  assert.deepEqual(
    recordProblems(
      [recorded(1, "a".repeat(64)), recorded(2, "b".repeat(64))],
      [onDisk(1, "a".repeat(64)), onDisk(2, "b".repeat(64))],
      GUEST,
    ),
    [],
  );
});

test("the newest version must pin the guest image's toolchain, and an older one may lag", () => {
  const old = [{ toolchain: "Node" as const, toolchainVersion: "24.0.0" }];
  assert.deepEqual(
    recordProblems(
      [recorded(1, "a".repeat(64)), recorded(2, "b".repeat(64))],
      [onDisk(1, "a".repeat(64), old), onDisk(2, "b".repeat(64))],
      GUEST,
    ),
    [],
  );
  assert.deepEqual(recordProblems([recorded(1, "a".repeat(64))], [onDisk(1, "a".repeat(64), old)], GUEST), [
    "the newest npm version, 1, pins Node 24.0.0 and the guest image carries Node 26.13.1; add a version that pins 26.13.1",
  ]);
});
