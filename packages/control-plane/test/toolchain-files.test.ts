import assert from "node:assert/strict";
import { test } from "node:test";
import { toolchainFindings } from "../src/toolchain-files.ts";

const GUEST = { Node: "26.13.1", Rust: "1.100.0", Python: "3.15.2" };

test("a toolchain file that asks for another version names both versions and the fix", () => {
  assert.deepEqual(
    toolchainFindings(
      [
        { path: "rust-toolchain.toml", text: '[toolchain]\nchannel = "1.95.0"\n' },
        { path: ".nvmrc", text: "v24.1.0\n" },
        { path: ".python-version", text: "3.12\n" },
      ],
      GUEST,
    ),
    [
      {
        code: "ToolchainMismatch",
        field: "rust-toolchain.toml",
        detail: "rust-toolchain.toml asks for Rust 1.95.0, and the guest image carries Rust 1.100.0",
        fix: 'set channel = "1.100.0" in rust-toolchain.toml',
      },
      {
        code: "ToolchainMismatch",
        field: ".nvmrc",
        detail: ".nvmrc asks for Node 24.1.0, and the guest image carries Node 26.13.1",
        fix: "set .nvmrc to 26.13.1",
      },
      {
        code: "ToolchainMismatch",
        field: ".python-version",
        detail: ".python-version asks for Python 3.12, and the guest image carries Python 3.15.2",
        fix: "set .python-version to 3.15.2",
      },
    ],
  );
});

test("a file that asks for the image's version, or a prefix of it, or a Node alias, is no finding", () => {
  assert.deepEqual(
    toolchainFindings(
      [
        { path: "rust-toolchain.toml", text: '[toolchain]\nchannel = "1.100.0"\ncomponents = ["clippy"]\n' },
        { path: ".nvmrc", text: "26\n" },
        { path: ".python-version", text: "3.15.2\n" },
      ],
      GUEST,
    ),
    [],
  );
  assert.deepEqual(toolchainFindings([{ path: ".nvmrc", text: "lts/*\n" }], GUEST), []);
});

test("a stable rust channel is a finding, since rustup would fetch another toolchain", () => {
  const [finding] = toolchainFindings([{ path: "rust-toolchain.toml", text: 'channel = "stable"' }], GUEST);
  assert.equal(finding?.detail, "rust-toolchain.toml asks for Rust stable, and the guest image carries Rust 1.100.0");
});
