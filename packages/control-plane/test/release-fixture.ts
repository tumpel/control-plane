import { ChannelProtocol } from "@tumpel/schemas";
import { CLAUDE_CODE_VERSION } from "../src/harness-catalog.ts";
import type { ReleaseManifest } from "../src/releases.ts";

export const CLAUDE_CODE_AMD64_RELEASE: ReleaseManifest = {
  releaseVersion: "0.2.0",
  commit: "e".repeat(40),
  channelProtocolVersion: ChannelProtocol.Version,
  supervisors: [
    {
      architecture: "Amd64",
      sha256: "a".repeat(64),
      sizeBytes: 4096,
      supervisorVersion: "0.1.0",
      downloadUrl: "https://github.com/tumpel/supervisor/releases/download/v0.1.0/tumpel-supervisor-x86_64-linux",
      guestProtocolVersion: 11,
    },
  ],
  clis: [
    {
      architecture: "Amd64",
      sha256: "f".repeat(64),
      sizeBytes: 2048,
      cliVersion: "0.2.1",
      downloadUrl: "https://github.com/tumpel/cli/releases/download/v0.2.1/tumpel-x86_64-linux",
    },
  ],
  images: [
    {
      harness: "ClaudeCode",
      harnessVersion: CLAUDE_CODE_VERSION,
      architecture: "Amd64",
      imageDigest: "b".repeat(64),
      kernelDigest: "c".repeat(64),
      manifestDigest: "d".repeat(64),
      ociDigest: "e".repeat(64),
      rootfsDigest: "9".repeat(64),
    },
  ],
  harnessLayers: [
    {
      harness: "ClaudeCode",
      harnessVersion: CLAUDE_CODE_VERSION,
      architecture: "Amd64",
      layerDigest: "1".repeat(64),
      manifestDigest: "2".repeat(64),
      sizeBytes: 65536,
    },
  ],
  bases: [
    {
      architecture: "Amd64",
      imageDigest: "3".repeat(64),
      kernelDigest: "c".repeat(64),
      manifestDigest: "4".repeat(64),
      ociDigest: "5".repeat(64),
      rootfsDigest: "6".repeat(64),
    },
  ],
};
