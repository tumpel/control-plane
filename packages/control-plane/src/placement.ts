import type { ReportedHostUsageSchema, UnplaceableSchema } from "@tumpel/schemas";
import type { z } from "zod";
import type { HostRecord as Host } from "./host-record.ts";
import type { HostArchitecture } from "./releases.ts";

export type ReportedHostUsage = Required<z.infer<typeof ReportedHostUsageSchema>> & { boxesWarm: number };

type TenantUnplaceable = z.infer<typeof UnplaceableSchema>;

export interface ImageAvailability {
  harness: string;
  harnessVersion: string;
  architectures: HostArchitecture[];
}

export type Unplaceable =
  | { kind: "Unplaceable"; host: Host; reason: "NotOnline" }
  | { kind: "Unplaceable"; host: Host; reason: "NotHealthy" }
  | { kind: "Unplaceable"; host: Host; reason: "NoImage"; image: ImageAvailability }
  | { kind: "Unplaceable"; host: Host; reason: "MemoryFull"; usage: ReportedHostUsage; boxMemoryMib: number }
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

const freeMemoryMib = ({ memoryBudgetMib, memoryHeldMib }: ReportedHostUsage): number =>
  memoryBudgetMib - memoryHeldMib;

const freeShare = (usage: ReportedHostUsage): number => freeMemoryMib(usage) / Math.max(usage.memoryBudgetMib, 1);

const withHeld = (usage: ReportedHostUsage, held: readonly HeldBox[]): ReportedHostUsage => ({
  ...usage,
  boxesWarm: held.filter((each) => each.hostId === usage.hostId).length,
});

const freeing = (usage: ReportedHostUsage, victims: readonly HeldBox[]): ReportedHostUsage => ({
  ...usage,
  boxesWarm: usage.boxesWarm - victims.length,
  memoryHeldMib: usage.memoryHeldMib - victims.reduce((sum, each) => sum + each.boxMemoryMib, 0),
  diskHeldMib: usage.diskHeldMib - victims.reduce((sum, each) => sum + each.boxDiskMib, 0),
});

const diskHeld = ({ diskBudgetMib, diskHeldMib }: ReportedHostUsage): number =>
  diskHeldMib === 0 ? 0 : Math.min(diskHeldMib / Math.max(diskBudgetMib, 1), 1);

const busyness = ({ host, usage }: Candidate): number =>
  usage.loadAverage / host.cpuCount -
  freeShare(usage) -
  (usage.memoryAvailableMib * MIB) / host.memoryBytes +
  diskHeld(usage);

const lacksDisk = ({ diskBudgetMib, diskHeldMib }: ReportedHostUsage, boxDiskMib: number): boolean =>
  diskHeldMib > 0 && diskHeldMib + boxDiskMib > diskBudgetMib;

export const shortOf = (usage: ReportedHostUsage, { boxMemoryMib, boxDiskMib }: BoxSize): "Memory" | "Disk" | null => {
  if (boxMemoryMib > freeMemoryMib(usage)) return "Memory";
  if (lacksDisk(usage, boxDiskMib)) return "Disk";
  return null;
};

const assess = (
  host: Host,
  usages: ReadonlyMap<string, ReportedHostUsage>,
  image: ImageAvailability,
  box: BoxSize,
  heardSince: number,
): Candidate | Unplaceable => {
  const { boxMemoryMib, boxDiskMib } = box;
  const usage = usages.get(host.hostId);
  if (host.state !== "Online" || usage === undefined || usage.updatedAt < heardSince)
    return { kind: "Unplaceable", host, reason: "NotOnline" };
  if (usage.reportedHealth !== "Healthy")
    return { kind: "Unplaceable", host: { ...host, reportedHealth: usage.reportedHealth }, reason: "NotHealthy" };
  if (!image.architectures.includes(host.architecture)) return { kind: "Unplaceable", host, reason: "NoImage", image };
  const short = shortOf(usage, box);
  if (short === "Memory") return { kind: "Unplaceable", host, reason: "MemoryFull", usage, boxMemoryMib };
  if (short === "Disk") return { kind: "Unplaceable", host, reason: "NoDisk", usage, boxDiskMib };
  return { kind: "Candidate", host, usage };
};

const evicting = (
  host: Host,
  usage: ReportedHostUsage,
  image: ImageAvailability,
  box: BoxSize,
  victims: readonly HeldBox[],
  heardSince: number,
): HeldBox[] | null => {
  for (let count = 1; count <= victims.length; count++) {
    const evict = victims.slice(0, count);
    const freed = assess(host, new Map([[host.hostId, freeing(usage, evict)]]), image, box, heardSince);
    if (freed.kind === "Candidate") return evict;
  }
  return null;
};

const isPlacementRefusal = (refused: TenantUnplaceable): refused is Unplaceable =>
  refused.reason !== "Full" &&
  refused.reason !== "NoMemory" &&
  (!("usage" in refused) ||
    (refused.usage.memoryBudgetMib !== undefined &&
      refused.usage.memoryHeldMib !== undefined &&
      refused.usage.diskBudgetMib !== undefined &&
      refused.usage.diskHeldMib !== undefined));

export const placementRefusals = (hosts: readonly TenantUnplaceable[]): Unplaceable[] =>
  hosts.map((refused) => {
    if (!isPlacementRefusal(refused))
      throw new Error(
        `the tenant refused host ${refused.host.hostId} as ${refused.reason}, which placement never answers`,
      );
    return refused;
  });

export type HostHeadroom = {
  reported_health: Host["reportedHealth"];
  memory_held_mib: number | null;
  memory_budget_mib: number | null;
  disk_held_mib: number | null;
  disk_budget_mib: number | null;
};

const rose = (before: number | null, after: number | null): boolean =>
  before !== null && after !== null && after > before;

export const sessionFreesRoom = (
  state: "Idle" | "Stopped" | "Failed" | "Archived",
  box: HeldBox | undefined,
): "PoolExhausted" | null => (state !== "Idle" || box?.evictable ? "PoolExhausted" : null);

export const roomFreed = (before: HostHeadroom, after: HostHeadroom): "PoolExhausted" | "HostDegraded" | null => {
  if (before.reported_health !== "Healthy" && after.reported_health === "Healthy") return "HostDegraded";
  return rose(after.memory_held_mib, before.memory_held_mib) ||
    rose(after.disk_held_mib, before.disk_held_mib) ||
    rose(before.memory_budget_mib, after.memory_budget_mib) ||
    rose(before.disk_budget_mib, after.disk_budget_mib)
    ? "PoolExhausted"
    : null;
};

export const degradedOnly = (hosts: readonly Unplaceable[]): boolean =>
  hosts.some(({ reason, host }) => reason === "NotOnline" && host.state === "Offline") &&
  hosts.every(({ reason }) => reason === "NotOnline" || reason === "NotHealthy");

export const placeSession = (
  hosts: readonly Host[],
  usages: readonly ReportedHostUsage[],
  image: ImageAvailability,
  box: BoxSize,
  held: readonly HeldBox[],
  heardSince: number,
): Placement => {
  const byHost = new Map(usages.map((usage) => [usage.hostId, withHeld(usage, held)]));
  const assessed = hosts.map((host) => assess(host, byHost, image, box, heardSince));
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
    const evict = evicting(host, usage, image, box, victims, heardSince);
    if (evict !== null) return { kind: "Placed", host, evict };
  }
  return { kind: "Refused", hosts: assessed.filter((each): each is Unplaceable => each.kind === "Unplaceable") };
};
