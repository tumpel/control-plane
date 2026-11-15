import { ChannelProtocol } from "@tumpel/api/schemas";
import { CLAUDE_CODE_VERSION } from "../src/harness-catalog.ts";
import type { ReleaseManifest } from "../src/releases.ts";

export const CLAUDE_CODE_AMD64_RELEASE: ReleaseManifest = {
  releaseVersion: "0.2.0",
  commit: "e".repeat(40),
  channelProtocolVersion: ChannelProtocol.Version,
  supervisors: [{ architecture: "Amd64", sha256: "a".repeat(64), sizeBytes: 4096 }],
  clis: [{ architecture: "Amd64", sha256: "f".repeat(64), sizeBytes: 2048 }],
  images: [
    {
      harness: "ClaudeCode",
      harnessVersion: CLAUDE_CODE_VERSION,
      architecture: "Amd64",
      imageDigest: "b".repeat(64),
      kernelDigest: "c".repeat(64),
      manifestDigest: "d".repeat(64),
      ociDigest: "e".repeat(64),
    },
  ],
};
