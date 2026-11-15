import type { BuildProviderKindSchema, PrebuildFailurePhaseSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { issuerSubject } from "./issuer.ts";
import type { InputFile } from "./prebuild-inputs.ts";
import type { Prebuild } from "./tenant-prebuilds";

export type BuildProviderKind = z.infer<typeof BuildProviderKindSchema>;
export type PrebuildFailurePhase = z.infer<typeof PrebuildFailurePhaseSchema>;

export interface PrebuildInputs {
  inputDigest: string;
  files: InputFile[];
}

export type Dispatched = { kind: "Started"; logUrl: string } | { kind: "Refused"; detail: string; fix: string };

export type ProviderStatus =
  | { kind: "Building" }
  | { kind: "Converting" }
  | { kind: "Done"; layerDigest: string; layerSizeBytes: number; finishedAt: string }
  | { kind: "Failed"; phase: PrebuildFailurePhase; detail: string; fix: string; failedAt: string };

export interface BuildProvider {
  dispatch(prebuild: Prebuild, inputs: PrebuildInputs): Promise<Dispatched>;
  status(prebuild: Prebuild): Promise<ProviderStatus>;
}

export const BUILD_PROVIDER_ORDER: readonly BuildProviderKind[] = ["CiDispatch", "RemoteBuildKit", "EphemeralVm"];

const ADAPTERS: ReadonlyMap<BuildProviderKind, BuildProvider> = new Map();

export const buildProviderFor = (kind: BuildProviderKind): BuildProvider | null => ADAPTERS.get(kind) ?? null;

export const COMMANDS: Record<BuildProviderKind, string> = {
  CiDispatch: "ci-dispatch",
  RemoteBuildKit: "remote-buildkit",
  EphemeralVm: "ephemeral-vm",
};

export const noAdapter = (kind: BuildProviderKind): { detail: string; fix: string } => ({
  detail: `this control plane has no ${kind} adapter yet, so the job was never sent to the provider`,
  fix: `Connect a build provider kind this control plane runs, or disconnect ${kind} with tumpel ${COMMANDS[kind]} delete`,
});

export const stageIssuer = (issuerHostname: string | undefined): string | null =>
  issuerHostname ? `https://${issuerHostname}` : null;

export const subjectPattern = (tenantId: string): string => issuerSubject(tenantId, "<personaName>");
