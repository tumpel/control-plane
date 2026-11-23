import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxDiskLimit, BoxMemoryLimit } from "@tumpel/schemas";
import type { HostRecord as Host } from "../src/host-record.ts";
import { type ImageAvailability, type Placement, placeSession, type ReportedHostUsage } from "../src/placement.ts";

const HOST: Host = {
  hostId: "host-base",
  tenantId: "tenant-placement",
  name: "base",
  state: "Online",
  health: "Healthy",
  reportedHealth: "Healthy",
  architecture: "Amd64",
  cpuCount: 4,
  memoryBytes: 8 * 1024 ** 3,
  publicKey: "key",
  supervisorVersion: "0.1.0",
  labels: [],
  createdAt: 0,
  updatedAt: 0,
};

const AMD64_IMAGES: ImageAvailability = { harness: "ClaudeCode", harnessVersion: "2.0.0", architectures: ["Amd64"] };

const BOX = { boxMemoryMib: BoxMemoryLimit.DefaultMib, boxDiskMib: BoxDiskLimit.DefaultMib };

const EMPTY = {
  tenantId: "tenant-placement",
  boxCapacity: 8,
  boxesRunning: 0,
  boxesWarm: 0,
  loadAverage: 0,
  memoryAvailableMib: 6144,
  memoryBudgetMib: 10_240,
  memoryHeldMib: 0,
  diskBudgetMib: 200_000,
  diskHeldMib: 0,
  channelProtocol: 28,
  createdAt: 0,
  updatedAt: 0,
};

const usageOf = (hostId: string, reported: Partial<ReportedHostUsage> = {}): ReportedHostUsage => ({
  ...EMPTY,
  hostId,
  ...reported,
});

const placed = (placement: Placement): string => {
  assert.equal(placement.kind, "Placed", JSON.stringify(placement));
  return placement.kind === "Placed" ? placement.host.name : "";
};

const reasons = (placement: Placement): string[][] =>
  placement.kind === "Refused" ? placement.hosts.map(({ host, reason }) => [host.name, reason]) : [];

test("a session goes to the online host least busy across load, memory and disk, ignoring offline hosts and hosts whose box memory is held", () => {
  const hosts: Host[] = [
    { ...HOST, hostId: "offline", name: "offline", state: "Offline" },
    { ...HOST, hostId: "full", name: "full" },
    { ...HOST, hostId: "free", name: "free" },
    { ...HOST, hostId: "freer", name: "freer" },
  ];
  const usages = [
    usageOf("offline", { memoryAvailableMib: 8192 }),
    usageOf("full", { memoryHeldMib: 10_240, loadAverage: 0.5, memoryAvailableMib: 8192 }),
    usageOf("free", { memoryHeldMib: 4096, loadAverage: 0.5, memoryAvailableMib: 8192 }),
    usageOf("freer", { memoryHeldMib: 2048, loadAverage: 3.5, memoryAvailableMib: 2048 }),
  ];
  assert.equal(placed(placeSession(hosts, usages, AMD64_IMAGES, BOX, [])), "free");
});

test("a loaded host with much free box memory loses to an idle host with little", () => {
  const hosts: Host[] = [
    { ...HOST, hostId: "box", name: "box", cpuCount: 16, memoryBytes: 58 * 1024 ** 3 },
    { ...HOST, hostId: "homelab", name: "homelab", cpuCount: 2, memoryBytes: 8 * 1024 ** 3 },
  ];
  const box = usageOf("box", {
    loadAverage: 14,
    memoryAvailableMib: 3072,
    memoryBudgetMib: 40_960,
    memoryHeldMib: 20_480,
  });
  const homelab = usageOf("homelab", { loadAverage: 0.05, memoryBudgetMib: 6144 });
  assert.equal(placed(placeSession(hosts, [box, homelab], AMD64_IMAGES, BOX, [])), "homelab");
  assert.equal(
    placed(placeSession(hosts, [box, { ...homelab, loadAverage: 3.9, memoryHeldMib: 4096 }], AMD64_IMAGES, BOX, [])),
    "box",
  );
});

test("a tenant whose hosts' box memory is all held is refused with each host's reason", () => {
  const hosts: Host[] = [
    { ...HOST, hostId: "full", name: "full" },
    { ...HOST, hostId: "arm", name: "arm", architecture: "Arm64" },
    { ...HOST, hostId: "gone", name: "gone", state: "Offline" },
  ];
  const full = usageOf("full", { memoryBudgetMib: 4096, memoryHeldMib: 4096 });
  const placement = placeSession(hosts, [full, { ...full, hostId: "arm" }], AMD64_IMAGES, BOX, []);
  assert.deepEqual(reasons(placement), [
    ["full", "MemoryFull"],
    ["arm", "NoImage"],
    ["gone", "NotOnline"],
  ]);
});

test("a host whose architecture has no image of the session's harness version in the current release is refused NoImage", () => {
  const usage = usageOf(HOST.hostId);
  const arm: ImageAvailability = { harness: "ClaudeCode", harnessVersion: "2.0.0", architectures: ["Arm64"] };
  const cases: [ImageAvailability, string[]][] = [
    [arm, ["Arm64"]],
    [{ harness: "ClaudeCode", harnessVersion: "1.9.0", architectures: [] }, []],
    [{ harness: "ClaudeCode", harnessVersion: "2.0.0", architectures: [] }, []],
  ];
  for (const [image, architectures] of cases) {
    const placement = placeSession([HOST], [usage], image, BOX, []);
    assert.deepEqual(
      placement.kind === "Refused"
        ? placement.hosts.map((each) => [each.reason, each.reason === "NoImage" ? [...each.image.architectures] : []])
        : placement,
      [["NoImage", architectures]],
    );
  }
  assert.equal(placed(placeSession([{ ...HOST, architecture: "Arm64" }], [usage], arm, BOX, [])), "base");
});

test("a held turn goes to a host with disk room, the fullest disk loses ties, and a host holding no box takes any disk", () => {
  const usage = (hostId: string, diskBudgetMib: number, diskHeldMib: number) =>
    usageOf(hostId, { diskBudgetMib, diskHeldMib });
  const full = { ...HOST, hostId: "full", name: "full" };
  const roomy = { ...HOST, hostId: "roomy", name: "roomy" };
  const busier = { ...HOST, hostId: "busier", name: "busier" };
  const refused = placeSession([full], [usage("full", 70_000, 65_536)], AMD64_IMAGES, BOX, []);
  assert.deepEqual(
    refused.kind === "Refused"
      ? refused.hosts.map((each) => [each.reason, each.reason === "NoDisk" ? each.boxDiskMib : 0])
      : refused,
    [["NoDisk", 32_768]],
  );
  assert.equal(
    placed(
      placeSession(
        [full, roomy],
        [usage("full", 70_000, 65_536), usage("roomy", 200_000, 32_768)],
        AMD64_IMAGES,
        BOX,
        [],
      ),
    ),
    "roomy",
  );
  assert.equal(
    placed(
      placeSession(
        [busier, roomy],
        [usage("busier", 200_000, 131_072), usage("roomy", 200_000, 32_768)],
        AMD64_IMAGES,
        BOX,
        [],
      ),
    ),
    "roomy",
  );
  assert.equal(placed(placeSession([full], [usage("full", 10_000, 0)], AMD64_IMAGES, BOX, [])), "full");
});

test("a placement refusal captures each host's name and reason: MemoryFull, NoDisk, NoImage, NotOnline", () => {
  const hosts: Host[] = [
    { ...HOST, hostId: "big", name: "example-host" },
    { ...HOST, hostId: "small", name: "tumpel" },
    { ...HOST, hostId: "arm", name: "arm-box", architecture: "Arm64" },
    { ...HOST, hostId: "gone", name: "offline-box", state: "Offline" },
  ];
  const usages = [
    usageOf("big", { memoryBudgetMib: 14_336, memoryHeldMib: 14_336, diskBudgetMib: 330_000, diskHeldMib: 65_536 }),
    usageOf("small", { diskBudgetMib: 21_000, diskHeldMib: 19_000 }),
    usageOf("arm", { diskBudgetMib: 21_000 }),
  ];
  assert.deepEqual(reasons(placeSession(hosts, usages, AMD64_IMAGES, BOX, [])), [
    ["example-host", "MemoryFull"],
    ["tumpel", "NoDisk"],
    ["arm-box", "NoImage"],
    ["offline-box", "NotOnline"],
  ]);
});

test("a host is refused only when the box's memory does not fit its budget, whatever its box slots", () => {
  const usage = (hostId: string, memoryHeldMib: number) =>
    usageOf(hostId, { boxCapacity: 2, boxesRunning: 5, memoryBudgetMib: 10_240, memoryHeldMib });
  const fits = { ...HOST, hostId: "fits", name: "fits" };
  const tight = { ...HOST, hostId: "tight", name: "tight" };
  const box = { boxMemoryMib: 2048, boxDiskMib: BoxDiskLimit.DefaultMib };
  assert.equal(
    placed(placeSession([tight, fits], [usage("tight", 8193), usage("fits", 8192)], AMD64_IMAGES, box, [])),
    "fits",
  );
  assert.deepEqual(reasons(placeSession([tight], [usage("tight", 8193)], AMD64_IMAGES, box, [])), [
    ["tight", "MemoryFull"],
  ]);
});

const heldBox = (sessionId: string, hostId: string, evictable: boolean, lastTurnEndedAt: number) => ({
  sessionId,
  hostId,
  evictable,
  lastTurnEndedAt,
  ...BOX,
});

const ONE_BOX = BoxMemoryLimit.DefaultMib;

test("free box memory on any host wins over evicting an Auto box", () => {
  const hosts = [
    { ...HOST, hostId: "held", name: "held" },
    { ...HOST, hostId: "spare", name: "spare" },
  ];
  const usages = [
    usageOf("held", { memoryBudgetMib: ONE_BOX, memoryHeldMib: ONE_BOX }),
    usageOf("spare", { memoryBudgetMib: ONE_BOX, loadAverage: 3.9 }),
  ];
  const placement = placeSession(hosts, usages, AMD64_IMAGES, BOX, [heldBox("old", "held", true, 1)]);
  assert.deepEqual(placement.kind === "Placed" && [placement.host.name, placement.evict], ["spare", []]);
});

test("with no free box memory the least recently used Auto box across hosts goes first", () => {
  const hosts = [
    { ...HOST, hostId: "a", name: "a" },
    { ...HOST, hostId: "b", name: "b" },
  ];
  const usages = [
    usageOf("a", { memoryBudgetMib: 2 * ONE_BOX, memoryHeldMib: 2 * ONE_BOX }),
    usageOf("b", { memoryBudgetMib: ONE_BOX, memoryHeldMib: ONE_BOX }),
  ];
  const held = [heldBox("a-new", "a", true, 30), heldBox("a-old", "a", true, 20), heldBox("b-oldest", "b", true, 10)];
  const placement = placeSession(hosts, usages, AMD64_IMAGES, BOX, held);
  assert.deepEqual(
    placement.kind === "Placed" && [placement.host.name, placement.evict.map((each) => each.sessionId)],
    ["b", ["b-oldest"]],
  );
});

test("a Warm box is never evicted, so a start beside only Warm and running boxes is refused MemoryFull", () => {
  const hosts = [
    { ...HOST, hostId: "warm", name: "warm" },
    { ...HOST, hostId: "busy", name: "busy" },
  ];
  const usages = [
    usageOf("warm", { memoryBudgetMib: ONE_BOX, memoryHeldMib: ONE_BOX }),
    usageOf("busy", { boxesRunning: 1, memoryBudgetMib: ONE_BOX, memoryHeldMib: ONE_BOX }),
  ];
  const placement = placeSession(hosts, usages, AMD64_IMAGES, BOX, [heldBox("kept", "warm", false, 1)]);
  assert.deepEqual(reasons(placement), [
    ["warm", "MemoryFull"],
    ["busy", "MemoryFull"],
  ]);
});

test("a host out of reserved memory evicts its oldest Auto box, never a Warm one, whatever its free slots", () => {
  const host = { ...HOST, hostId: "budget", name: "budget" };
  const usage = usageOf("budget", { memoryBudgetMib: 6144, memoryHeldMib: 6144 });
  const box = { ...BOX, boxMemoryMib: 2048 };
  const held = [
    { ...heldBox("warm", "budget", false, 1), boxMemoryMib: 2048 },
    { ...heldBox("auto-old", "budget", true, 2), boxMemoryMib: 2048 },
    { ...heldBox("auto-new", "budget", true, 3), boxMemoryMib: 2048 },
  ];
  const placement = placeSession([host], [usage], AMD64_IMAGES, box, held);
  assert.deepEqual(placement.kind === "Placed" && placement.evict.map((each) => each.sessionId), ["auto-old"]);
});
