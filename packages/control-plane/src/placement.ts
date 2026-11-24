import type { ReportedHostUsageSchema, SessionSchema, UnplaceableSchema } from "@tumpel/schemas";
import type { z } from "zod";
import type { HostRecord as Host } from "./host-record.ts";
import { type Refused, refuse } from "./http.ts";
import { type HostArchitecture, imageNotReleased } from "./releases.ts";

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

export const why = (refused: Unplaceable): string => {
  const named = refused.host.name;
  if (refused.reason === "NotOnline" && refused.host.state === "Offline")
    return `${named} has not reported to the control plane within its heartbeat grace and counts as Degraded until it sends a heartbeat`;
  if (refused.reason === "NotOnline") return `${named} is ${refused.host.state}`;
  if (refused.reason === "NotHealthy") return `${named} reports itself ${refused.host.reportedHealth}`;
  if (refused.reason === "NoImage") {
    const { harness, harnessVersion, architectures } = refused.image;
    const carried =
      architectures.length === 0
        ? `no ${harness} ${harnessVersion} guest image`
        : `${harness} ${harnessVersion} guest images for ${architectures.join(", ")} only`;
    return `${named} is ${refused.host.architecture}, and the current release carries ${carried}`;
  }
  if (refused.reason === "NoConnectors") {
    return `${named} runs a supervisor too old to serve connectors`;
  }
  if (refused.reason === "NoDisk") {
    return `${named} gives box disks ${refused.usage.diskBudgetMib} MiB and its boxes hold ${refused.usage.diskHeldMib} MiB of it, and the persona's boxes need ${refused.boxDiskMib} MiB`;
  }
  return `${named} gives boxes ${refused.usage.memoryBudgetMib} MiB of memory and its boxes hold ${refused.usage.memoryHeldMib} MiB of it, and the persona's boxes need ${refused.boxMemoryMib} MiB`;
};

export const placeableFix = (hosts: Unplaceable[], retry: string): string => {
  const [lacking] = hosts.flatMap((each) => (each.reason === "NoImage" ? [each.image] : []));
  if (lacking === undefined && hosts.some(({ reason }) => reason === "NoConnectors")) {
    return `Let a host update its supervisor to the current release, or use a persona without connectors, then ${retry}`;
  }
  if (lacking === undefined && hosts.some(({ reason }) => reason === "NoDisk")) {
    return `Lower the persona's boxDiskMib toward the 32768 MiB default, free disk on a host, or enrol a host with more disk, then ${retry}`;
  }
  if (lacking === undefined) {
    return `Start the supervisor on a host, or enrol a new host, then ${retry}`;
  }
  const { harness, harnessVersion, architectures } = lacking;
  if (architectures.length === 0) {
    return `Pin a harness version the current release carries, or ask the operator, who publishes releases, for one that carries a ${harness} ${harnessVersion} guest image, then ${retry}`;
  }
  return `Start the supervisor on an ${architectures.join(" or ")} host, or enrol a new one, then ${retry}`;
};

export const unplaced = (tenantRefusals: Parameters<typeof placementRefusals>[0], retry: string): Refused => {
  const hosts = placementRefusals(tenantRefusals);
  if (hosts.length === 0) {
    return refuse(409, {
      code: "NoHostAvailable",
      title: "No host online",
      detail: "your tenant has no hosts",
      fix: `Enrol a host and start the supervisor on it, then ${retry}`,
    });
  }
  const [first] = hosts;
  if (
    first?.reason === "NoImage" &&
    first.image.architectures.length === 0 &&
    hosts.every((host) => host.reason === "NoImage")
  ) {
    return {
      ok: false,
      status: 422,
      problem: imageNotReleased(first.image.harness, first.image.harnessVersion, retry),
    };
  }
  const detail = hosts.map(why).join(", ");
  if (degradedOnly(hosts)) {
    return refuse(409, {
      code: "HostDegraded",
      title: "No healthy host",
      detail: `no host of your tenant is healthy: ${detail}`,
      fix: `Check that tumpel-supervisor runs on a host and reaches the control plane, then ${retry}`,
    });
  }
  if (hosts.some(({ reason }) => reason === "MemoryFull")) {
    return refuse(409, {
      code: "PoolExhausted",
      title: "Every host's box memory is in use",
      detail: `no host of your tenant has memory for another box: ${detail}`,
      fix: `Wait for a running turn to finish, lower the persona's boxMemoryMib, or enrol another host, then ${retry}`,
    });
  }
  return refuse(409, {
    code: "NoHostAvailable",
    title: "No host can take the session",
    detail: `no host of your tenant can take a session: ${detail}`,
    fix: placeableFix(hosts, retry),
  });
};

export const stranded = (
  session: Pick<z.infer<typeof SessionSchema>, "hostId" | "sessionId">,
  hosts: Host[],
  missingTurnIds: string[],
): Refused => {
  const host = hosts.find((listed) => listed.hostId === session.hostId);
  if (host === undefined) {
    throw new Error(`session ${session.sessionId} runs on host ${session.hostId}, which its tenant does not list`);
  }
  return refuse(409, {
    code: "HostOffline",
    title: "Host offline",
    detail: `the session runs on host ${host.name}, which is ${host.state}, and its snapshots miss ${missingTurnIds.length} completed ${missingTurnIds.length === 1 ? "turn" : "turns"}, so it cannot move to another host`,
    fix:
      host.state === "Revoked"
        ? "The host was revoked and cannot snapshot those turns; enrol a new host"
        : "Start tumpel-supervisor run on that host so it snapshots those turns, then send the turn again",
  });
};
