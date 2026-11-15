import type { HostSchema, ReportedHostUsageSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import type { HostArchitecture } from "./harness-catalog.ts";

type Host = z.infer<typeof HostSchema>;

export type ReportedHostUsage = z.infer<typeof ReportedHostUsageSchema>;

export type Unplaceable =
  | { kind: "Unplaceable"; host: Host; reason: "NotOnline" }
  | { kind: "Unplaceable"; host: Host; reason: "NoImage" }
  | { kind: "Unplaceable"; host: Host; reason: "Full"; usage: ReportedHostUsage };

type Candidate = { kind: "Candidate"; host: Host; usage: ReportedHostUsage };

export type Placement = { kind: "Placed"; host: Host } | { kind: "Refused"; hosts: Unplaceable[] };

const freeSlots = (usage: ReportedHostUsage): number => usage.boxCapacity - usage.boxesRunning - usage.boxesWarm;

const assess = (
  host: Host,
  usages: ReadonlyMap<string, ReportedHostUsage>,
  architectures: readonly HostArchitecture[],
): Candidate | Unplaceable => {
  if (host.state !== "Online") return { kind: "Unplaceable", host, reason: "NotOnline" };
  if (!architectures.includes(host.architecture)) return { kind: "Unplaceable", host, reason: "NoImage" };
  const usage = usages.get(host.hostId);
  if (usage === undefined) {
    throw new Error(`host ${host.hostId} is Online but its tenant holds no usage from its Hello`);
  }
  if (usage.boxesRunning >= usage.boxCapacity) return { kind: "Unplaceable", host, reason: "Full", usage };
  return { kind: "Candidate", host, usage };
};

export const placeSession = (
  hosts: readonly Host[],
  usages: readonly ReportedHostUsage[],
  architectures: readonly HostArchitecture[],
): Placement => {
  const byHost = new Map(usages.map((usage) => [usage.hostId, usage]));
  const assessed = hosts.map((host) => assess(host, byHost, architectures));
  const [best] = assessed
    .filter((each): each is Candidate => each.kind === "Candidate")
    .sort((a, b) => freeSlots(b.usage) - freeSlots(a.usage) || b.usage.memoryAvailableMib - a.usage.memoryAvailableMib);
  if (best !== undefined) return { kind: "Placed", host: best.host };
  return { kind: "Refused", hosts: assessed.filter((each): each is Unplaceable => each.kind === "Unplaceable") };
};
