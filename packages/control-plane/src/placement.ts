import type { HostSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import type { HostArchitecture } from "./harness-catalog.ts";

type Host = z.infer<typeof HostSchema>;

type Usage = NonNullable<Host["usage"]>;

export type Unplaceable =
  | { kind: "Unplaceable"; host: Host; reason: "NotOnline" }
  | { kind: "Unplaceable"; host: Host; reason: "NoUsage" }
  | { kind: "Unplaceable"; host: Host; reason: "NoImage"; usage: Usage }
  | { kind: "Unplaceable"; host: Host; reason: "Full"; usage: Usage };

type Candidate = { kind: "Candidate"; host: Host; usage: Usage };

export type Placement = { kind: "Placed"; host: Host } | { kind: "Refused"; hosts: Unplaceable[] };

const freeSlots = (usage: Usage): number => usage.boxCapacity - usage.boxesRunning - usage.boxesWarm;

const assess = (host: Host, architectures: readonly HostArchitecture[]): Candidate | Unplaceable => {
  if (host.state !== "Online") return { kind: "Unplaceable", host, reason: "NotOnline" };
  const { usage } = host;
  if (usage === undefined) return { kind: "Unplaceable", host, reason: "NoUsage" };
  if (!architectures.includes(usage.architecture)) return { kind: "Unplaceable", host, reason: "NoImage", usage };
  if (usage.boxesRunning >= usage.boxCapacity) return { kind: "Unplaceable", host, reason: "Full", usage };
  return { kind: "Candidate", host, usage };
};

export const placeSession = (hosts: readonly Host[], architectures: readonly HostArchitecture[]): Placement => {
  const assessed = hosts.map((host) => assess(host, architectures));
  const [best] = assessed
    .filter((each): each is Candidate => each.kind === "Candidate")
    .sort((a, b) => freeSlots(b.usage) - freeSlots(a.usage) || b.usage.memoryAvailableMib - a.usage.memoryAvailableMib);
  if (best !== undefined) return { kind: "Placed", host: best.host };
  return { kind: "Refused", hosts: assessed.filter((each): each is Unplaceable => each.kind === "Unplaceable") };
};
