import type { HostSchema, ReportedHostUsageSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import type { HostArchitecture } from "./releases.ts";

type Host = z.infer<typeof HostSchema>;

export type ReportedHostUsage = z.infer<typeof ReportedHostUsageSchema>;

export interface ImageAvailability {
  harness: string;
  harnessVersion: string;
  architectures: readonly HostArchitecture[];
}

export type Unplaceable =
  | { kind: "Unplaceable"; host: Host; reason: "NotOnline" }
  | { kind: "Unplaceable"; host: Host; reason: "NoImage"; image: ImageAvailability }
  | { kind: "Unplaceable"; host: Host; reason: "Full"; usage: ReportedHostUsage };

type Candidate = { kind: "Candidate"; host: Host; usage: ReportedHostUsage };

export type Placement = { kind: "Placed"; host: Host } | { kind: "Refused"; hosts: Unplaceable[] };

const freeSlots = (usage: ReportedHostUsage): number => usage.boxCapacity - usage.boxesRunning - usage.boxesWarm;

const assess = (
  host: Host,
  usages: ReadonlyMap<string, ReportedHostUsage>,
  image: ImageAvailability,
): Candidate | Unplaceable => {
  if (host.state !== "Online") return { kind: "Unplaceable", host, reason: "NotOnline" };
  if (!image.architectures.includes(host.architecture)) return { kind: "Unplaceable", host, reason: "NoImage", image };
  const usage = usages.get(host.hostId);
  if (usage === undefined) {
    throw new Error(
      `host ${host.name} (${host.hostId}) is Online but its tenant holds no usage from its Hello; restart tumpel-supervisor run on that host so its Hello carries its usage`,
    );
  }
  if (usage.boxesRunning >= usage.boxCapacity) return { kind: "Unplaceable", host, reason: "Full", usage };
  return { kind: "Candidate", host, usage };
};

export const placeSession = (
  hosts: readonly Host[],
  usages: readonly ReportedHostUsage[],
  image: ImageAvailability,
): Placement => {
  const byHost = new Map(usages.map((usage) => [usage.hostId, usage]));
  const assessed = hosts.map((host) => assess(host, byHost, image));
  const [best] = assessed
    .filter((each): each is Candidate => each.kind === "Candidate")
    .sort((a, b) => freeSlots(b.usage) - freeSlots(a.usage) || b.usage.memoryAvailableMib - a.usage.memoryAvailableMib);
  if (best !== undefined) return { kind: "Placed", host: best.host };
  return { kind: "Refused", hosts: assessed.filter((each): each is Unplaceable => each.kind === "Unplaceable") };
};
