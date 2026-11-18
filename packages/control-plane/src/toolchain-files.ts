import type { Finding } from "./devcontainer.ts";
import type { Toolchain } from "./guest-toolchains.ts";

export interface ToolchainFile {
  path: string;
  text: string;
}

interface Pin {
  toolchain: Toolchain;
  requested: string;
  fix: (version: string) => string;
}

const RUST_CHANNEL = /^\s*channel\s*=\s*["']([^"']+)["']/m;
const NODE_ALIASES = /^(lts\/.+|node|latest)$/;

const pinOf = (file: ToolchainFile): Pin | null => {
  if (file.path === "rust-toolchain.toml") {
    const channel = RUST_CHANNEL.exec(file.text)?.[1];
    if (channel === undefined) return null;
    return {
      toolchain: "Rust",
      requested: channel,
      fix: (version) => `set channel = "${version}" in rust-toolchain.toml`,
    };
  }
  const requested = file.text.split("\n")[0]?.trim() ?? "";
  if (requested === "") return null;
  if (file.path === ".nvmrc") {
    if (NODE_ALIASES.test(requested)) return null;
    return { toolchain: "Node", requested: requested.replace(/^v/, ""), fix: (version) => `set .nvmrc to ${version}` };
  }
  if (file.path === ".python-version")
    return { toolchain: "Python", requested, fix: (version) => `set .python-version to ${version}` };
  return null;
};

const matches = (requested: string, carried: string): boolean => {
  const parts = requested.split(".");
  const carriedParts = carried.split(".");
  return parts.length <= carriedParts.length && parts.every((part, index) => part === carriedParts[index]);
};

export const toolchainFindings = (
  files: readonly ToolchainFile[],
  guest: Readonly<Record<Toolchain, string>>,
): Finding[] =>
  files.flatMap((file) => {
    const pin = pinOf(file);
    if (pin === null || matches(pin.requested, guest[pin.toolchain])) return [];
    return [
      {
        code: "ToolchainMismatch",
        field: file.path,
        detail: `${file.path} asks for ${pin.toolchain} ${pin.requested}, and the guest image carries ${pin.toolchain} ${guest[pin.toolchain]}`,
        fix: pin.fix(guest[pin.toolchain]),
      },
    ];
  });
