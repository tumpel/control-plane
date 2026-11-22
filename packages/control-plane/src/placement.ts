import { BoxMemoryLimit, type ReportedHostUsageSchema } from "@tumpel/schemas";
import type { z } from "zod";
import type { HostRecord as Host } from "./host-record.ts";
import type { HostArchitecture } from "./releases.ts";

export type ReportedHostUsage = z.infer<typeof ReportedHostUsageSchema>;

export interface ImageAvailability {
  harness: string;
  harnessVersion: string;
  architectures: HostArchitecture[];
}

export type Unplaceable =
  | { kind: "Unplaceable"; host: Host; reason: "NotOnline" }
  | { kind: "Unplaceable"; host: Host; reason: "NotHealthy" }
  | { kind: "Unplaceable"; host: Host; reason: "NoImage"; image: ImageAvailability }
  | { kind: "Unplaceable"; host: Host; reason: "Full"; usage: ReportedHostUsage }
  | { kind: "Unplaceable"; host: Host; reason: "MemoryFull"; usage: ReportedHostUsage; boxMemoryMib: number }
  | { kind: "Unplaceable"; host: Host; reason: "NoMemory"; usage: ReportedHostUsage; boxMemoryMib: number }
  | { kind: "Unplaceable"; host: Host; reason: "NoDisk"; usage: ReportedHostUsage; boxDiskMib: number }
  | { kind: "Unplaceable"; host: Host; reason: "NoConnectors"; usage: ReportedHostUsage };

export interface BoxSize {
  boxMemoryMib: number;
  boxDiskMib: number;
}

export interface HeldBox extends BoxSize {
  sessionId: string;
  hostId: string;
  evictable: boolean;
  lastTurnEndedAt: number;
}

type Candidate = { kind: "Candidate"; host: Host; usage: ReportedHostUsage };

export type Placement = { kind: "Placed"; host: Host; evict: HeldBox[] } | { kind: "Refused"; hosts: Unplaceable[] };

const MIB = 1024 ** 2;

const freeSlots = (usage: ReportedHostUsage): number => usage.boxCapacity - usage.boxesRunning - usage.boxesWarm;

const freeMemoryMib = ({ memoryBudgetMib, memoryHeldMib }: ReportedHostUsage): number | undefined =>
  memoryBudgetMib === undefined || memoryHeldMib === undefined ? undefined : memoryBudgetMib - memoryHeldMib;

const freeShare = (usage: ReportedHostUsage): number => {
  const free = freeMemoryMib(usage);
  if (free === undefined) return freeSlots(usage) / usage.boxCapacity;
  return free / Math.max(usage.memoryBudgetMib ?? 0, 1);
};

const withHeld = (usage: ReportedHostUsage, held: readonly HeldBox[]): ReportedHostUsage => ({
  ...usage,
  boxesWarm: held.filter((each) => each.hostId === usage.hostId).length,
});

const freeing = (usage: ReportedHostUsage, victims: readonly HeldBox[]): ReportedHostUsage => ({
  ...usage,
  boxesWarm: usage.boxesWarm - victims.length,
  ...(usage.memoryHeldMib === undefined
    ? {}
    : { memoryHeldMib: usage.memoryHeldMib - victims.reduce((sum, each) => sum + each.boxMemoryMib, 0) }),
  ...(usage.diskHeldMib === undefined
    ? {}
    : { diskHeldMib: usage.diskHeldMib - victims.reduce((sum, each) => sum + each.boxDiskMib, 0) }),
});

const diskHeld = ({ diskBudgetMib, diskHeldMib }: ReportedHostUsage): number =>
  diskBudgetMib === undefined || diskHeldMib === undefined || diskHeldMib === 0
    ? 0
    : Math.min(diskHeldMib / Math.max(diskBudgetMib, 1), 1);

const busyness = ({ host, usage }: Candidate): number =>
  usage.loadAverage / host.cpuCount -
  freeShare(usage) -
  (usage.memoryAvailableMib * MIB) / host.memoryBytes +
  diskHeld(usage);

const lacksDisk = ({ diskBudgetMib, diskHeldMib }: ReportedHostUsage, boxDiskMib: number): boolean =>
  diskBudgetMib !== undefined &&
  diskHeldMib !== undefined &&
  diskHeldMib > 0 &&
  diskHeldMib + boxDiskMib > diskBudgetMib;

const assess = (
  host: Host,
  usages: ReadonlyMap<string, ReportedHostUsage>,
  image: ImageAvailability,
  { boxMemoryMib, boxDiskMib }: BoxSize,
): Candidate | Unplaceable => {
  const usage = usages.get(host.hostId);
  if (host.state !== "Online" || usage === undefined) return { kind: "Unplaceable", host, reason: "NotOnline" };
  if (host.health !== "Healthy" || host.reportedHealth !== "Healthy")
    return { kind: "Unplaceable", host, reason: "NotHealthy" };
  if (!image.architectures.includes(host.architecture)) return { kind: "Unplaceable", host, reason: "NoImage", image };
  const freeMemory = freeMemoryMib(usage);
  if (freeMemory !== undefined && boxMemoryMib > freeMemory)
    return { kind: "Unplaceable", host, reason: "MemoryFull", usage, boxMemoryMib };
  if (freeMemory === undefined && usage.boxesRunning + usage.boxesWarm >= usage.boxCapacity)
    return { kind: "Unplaceable", host, reason: "Full", usage };
  if (freeMemory === undefined && boxMemoryMib > BoxMemoryLimit.DefaultMib && usage.memoryAvailableMib < boxMemoryMib)
    return { kind: "Unplaceable", host, reason: "NoMemory", usage, boxMemoryMib };
  if (lacksDisk(usage, boxDiskMib)) return { kind: "Unplaceable", host, reason: "NoDisk", usage, boxDiskMib };
  return { kind: "Candidate", host, usage };
};

const evicting = (
  host: Host,
  usage: ReportedHostUsage,
  image: ImageAvailability,
  box: BoxSize,
  victims: readonly HeldBox[],
): HeldBox[] | null => {
  for (let count = 1; count <= victims.length; count++) {
    const evict = victims.slice(0, count);
    const freed = assess(host, new Map([[host.hostId, freeing(usage, evict)]]), image, box);
    if (freed.kind === "Candidate") return evict;
  }
  return null;
};

export const degradedOnly = (hosts: readonly { reason: string; host: Host }[]): boolean =>
  hosts.some(({ reason, host }) => reason === "NotHealthy" && host.health === "Degraded") &&
  hosts.every(({ reason }) => reason === "NotOnline" || reason === "NotHealthy");

export const placeSession = (
  hosts: readonly Host[],
  usages: readonly ReportedHostUsage[],
  image: ImageAvailability,
  box: BoxSize,
  held: readonly HeldBox[],
): Placement => {
  const byHost = new Map(usages.map((usage) => [usage.hostId, withHeld(usage, held)]));
  const assessed = hosts.map((host) => assess(host, byHost, image, box));
  const [best] = assessed
    .filter((each): each is Candidate => each.kind === "Candidate")
    .sort((a, b) => busyness(a) - busyness(b) || freeSlots(b.usage) - freeSlots(a.usage));
  if (best !== undefined) return { kind: "Placed", host: best.host, evict: [] };
  const evictable = held
    .filter((each) => each.evictable)
    .sort((a, b) => a.lastTurnEndedAt - b.lastTurnEndedAt || a.sessionId.localeCompare(b.sessionId));
  for (const hostId of new Set(evictable.map((each) => each.hostId))) {
    const host = hosts.find((each) => each.hostId === hostId);
    const usage = byHost.get(hostId);
    if (host === undefined || usage === undefined) continue;
    const victims = evictable.filter((each) => each.hostId === hostId);
    const evict = evicting(host, usage, image, box, victims);
    if (evict !== null) return { kind: "Placed", host, evict };
  }
  return { kind: "Refused", hosts: assessed.filter((each): each is Unplaceable => each.kind === "Unplaceable") };
};
