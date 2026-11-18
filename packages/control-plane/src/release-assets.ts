import type { HostArchitecture } from "./releases.ts";

export const SUPERVISOR_REPOSITORY = "tumpel/supervisor";
export const CLI_REPOSITORY = "tumpel/cli";

const MACHINES: Record<HostArchitecture, string> = { Amd64: "x86_64", Arm64: "aarch64" };

export const supervisorAsset = (architecture: HostArchitecture): string =>
  `tumpel-supervisor-${MACHINES[architecture]}-linux`;

export const guestAsset = (architecture: HostArchitecture): string => `tumpel-guest-${MACHINES[architecture]}-linux`;

export const cliAsset = (architecture: HostArchitecture): string => `tumpel-${MACHINES[architecture]}-linux`;

export const releaseAssetUrl = (repository: string, version: string, asset: string): string =>
  `https://github.com/${repository}/releases/download/v${version}/${asset}`;
