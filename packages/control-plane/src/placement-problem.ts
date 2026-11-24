import { ProblemSchema } from "@tumpel/schemas";
import type { z } from "zod";
import { boundedTo } from "./bounded-detail.ts";

const refuse = (status: 409, problem: z.infer<typeof ProblemSchema>) => ({
  ok: false as const,
  status,
  problem: { ...problem, detail: boundedTo(ProblemSchema.shape.detail.maxLength, problem.detail) },
});

import { degradedOnly, placementRefusals, type Unplaceable } from "./placement.ts";

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

export const unplaced = (
  tenantRefusals: Parameters<typeof placementRefusals>[0],
  retry: string,
): ReturnType<typeof refuse> => {
  const hosts = placementRefusals(tenantRefusals);
  if (hosts.length === 0) {
    return refuse(409, {
      code: "NoHostAvailable",
      title: "No host online",
      detail: "your tenant has no hosts",
      fix: `Enrol a host and start the supervisor on it, then ${retry}`,
    });
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
