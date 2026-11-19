import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxDiskLimit, BoxMemoryLimit } from "@tumpel/schemas";
import type { HostRecord as Host } from "../src/host-record.ts";
import { type ImageAvailability, type Placement, placeSession } from "../src/placement.ts";

const HOST: Host = {
  hostId: "host-base",
  tenantId: "tenant-placement",
  name: "base",
  state: "Online",
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

const placed = (placement: Placement): string => {
  assert.equal(placement.kind, "Placed", JSON.stringify(placement));
  return placement.kind === "Placed" ? placement.host.name : "";
};

test("a session goes to the online host least busy across box slots, load and memory, ignoring offline and full hosts", () => {
  const hosts: Host[] = [
    { ...HOST, hostId: "offline", name: "offline", state: "Offline" },
    { ...HOST, hostId: "full", name: "full" },
    { ...HOST, hostId: "free", name: "free" },
    { ...HOST, hostId: "freer", name: "freer" },
  ];
  const usages = [
    {
      hostId: "offline",
      tenantId: "tenant-placement",
      boxCapacity: 256,
      boxesRunning: 0,
      boxesWarm: 0,
      loadAverage: 0,
      memoryAvailableMib: 8192,
      channelProtocol: 18,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      hostId: "full",
      tenantId: "tenant-placement",
      boxCapacity: 4,
      boxesRunning: 4,
      boxesWarm: 0,
      loadAverage: 0.5,
      memoryAvailableMib: 8192,
      channelProtocol: 18,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      hostId: "free",
      tenantId: "tenant-placement",
      boxCapacity: 8,
      boxesRunning: 3,
      boxesWarm: 2,
      loadAverage: 0.5,
      memoryAvailableMib: 8192,
      channelProtocol: 18,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      hostId: "freer",
      tenantId: "tenant-placement",
      boxCapacity: 6,
      boxesRunning: 1,
      boxesWarm: 0,
      loadAverage: 3.5,
      memoryAvailableMib: 2048,
      channelProtocol: 18,
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  assert.equal(placed(placeSession(hosts, usages, AMD64_IMAGES, BOX, false, [])), "free");
});

test("a loaded host with many free slots loses to an idle host with few", () => {
  const hosts: Host[] = [
    { ...HOST, hostId: "box", name: "box", cpuCount: 16, memoryBytes: 58 * 1024 ** 3 },
    { ...HOST, hostId: "homelab", name: "homelab", cpuCount: 2, memoryBytes: 8 * 1024 ** 3 },
  ];
  const box = {
    hostId: "box",
    tenantId: "tenant-placement",
    boxCapacity: 32,
    boxesRunning: 10,
    boxesWarm: 0,
    loadAverage: 14,
    memoryAvailableMib: 3072,
    channelProtocol: 18,
    createdAt: 0,
    updatedAt: 0,
  };
  const homelab = {
    hostId: "homelab",
    tenantId: "tenant-placement",
    boxCapacity: 2,
    boxesRunning: 0,
    boxesWarm: 0,
    loadAverage: 0.05,
    memoryAvailableMib: 6144,
    channelProtocol: 18,
    createdAt: 0,
    updatedAt: 0,
  };
  assert.equal(placed(placeSession(hosts, [box, homelab], AMD64_IMAGES, BOX, false, [])), "homelab");
  assert.equal(
    placed(placeSession(hosts, [box, { ...homelab, boxesWarm: 1, loadAverage: 3.9 }], AMD64_IMAGES, BOX, false, [])),
    "box",
  );
});

test("a host whose every slot is warm and whose memory is low still takes a default-memory session, since the supervisor evicts a warm box", () => {
  const usage = {
    hostId: "warm",
    tenantId: "tenant-placement",
    boxCapacity: 2,
    boxesRunning: 0,
    boxesWarm: 2,
    loadAverage: 0.2,
    memoryAvailableMib: 1024,
    channelProtocol: 18,
    createdAt: 0,
    updatedAt: 0,
  };
  assert.equal(
    placed(placeSession([{ ...HOST, hostId: "warm", name: "warm" }], [usage], AMD64_IMAGES, BOX, false, [])),
    "warm",
  );
});

test("a tenant whose hosts all run a turn in every slot is refused with each host's reason", () => {
  const hosts: Host[] = [
    { ...HOST, hostId: "full", name: "full" },
    { ...HOST, hostId: "arm", name: "arm", architecture: "Arm64" },
    { ...HOST, hostId: "gone", name: "gone", state: "Offline" },
  ];
  const full = {
    hostId: "full",
    tenantId: "tenant-placement",
    boxCapacity: 2,
    boxesRunning: 2,
    boxesWarm: 0,
    loadAverage: 2,
    memoryAvailableMib: 4096,
    channelProtocol: 18,
    createdAt: 0,
    updatedAt: 0,
  };
  const placement = placeSession(hosts, [full], AMD64_IMAGES, BOX, false, []);
  assert.deepEqual(placement.kind === "Refused" ? placement.hosts.map(({ host, reason }) => [host.name, reason]) : [], [
    ["full", "Full"],
    ["arm", "NoImage"],
    ["gone", "NotOnline"],
  ]);
});

test("a host whose architecture has no image of the session's harness version in the current release is refused NoImage", () => {
  const usage = {
    hostId: HOST.hostId,
    tenantId: "tenant-placement",
    boxCapacity: 4,
    boxesRunning: 0,
    boxesWarm: 0,
    loadAverage: 0,
    memoryAvailableMib: 4096,
    channelProtocol: 18,
    createdAt: 0,
    updatedAt: 0,
  };
  const arm: ImageAvailability = { harness: "ClaudeCode", harnessVersion: "2.0.0", architectures: ["Arm64"] };
  const cases: [ImageAvailability, string[]][] = [
    [arm, ["Arm64"]],
    [{ harness: "ClaudeCode", harnessVersion: "1.9.0", architectures: [] }, []],
    [{ harness: "ClaudeCode", harnessVersion: "2.0.0", architectures: [] }, []],
  ];
  for (const [image, architectures] of cases) {
    const placement = placeSession([HOST], [usage], image, BOX, false, []);
    assert.deepEqual(
      placement.kind === "Refused"
        ? placement.hosts.map((each) => [each.reason, each.reason === "NoImage" ? [...each.image.architectures] : []])
        : placement,
      [["NoImage", architectures]],
    );
  }
  assert.equal(placed(placeSession([{ ...HOST, architecture: "Arm64" }], [usage], arm, BOX, false, [])), "base");
});

test("a host whose available memory is below a persona's box memory above the default is refused NoMemory", () => {
  const usage = (hostId: string, memoryAvailableMib: number) => ({
    hostId,
    tenantId: "tenant-placement",
    boxCapacity: 4,
    boxesRunning: 0,
    boxesWarm: 0,
    loadAverage: 0,
    memoryAvailableMib,
    channelProtocol: 18,
    createdAt: 0,
    updatedAt: 0,
  });
  const small = { ...HOST, hostId: "small", name: "small" };
  const large = { ...HOST, hostId: "large", name: "large" };
  const refused = placeSession(
    [small],
    [usage("small", 6144)],
    AMD64_IMAGES,
    { ...BOX, boxMemoryMib: 8192 },
    false,
    [],
  );
  assert.deepEqual(
    refused.kind === "Refused"
      ? refused.hosts.map((each) => [each.reason, each.reason === "NoMemory" ? each.boxMemoryMib : 0])
      : refused,
    [["NoMemory", 8192]],
  );
  assert.equal(
    placed(
      placeSession(
        [small, large],
        [usage("small", 6144), usage("large", 16384)],
        AMD64_IMAGES,
        {
          ...BOX,
          boxMemoryMib: 8192,
        },
        false,
        [],
      ),
    ),
    "large",
  );
});

test("a held turn goes to a host with disk room, the fullest disk loses ties, and a host holding no box takes any disk", () => {
  const usage = (hostId: string, diskBudgetMib: number, diskHeldMib: number) => ({
    hostId,
    tenantId: "tenant-placement",
    boxCapacity: 4,
    boxesRunning: 0,
    boxesWarm: 0,
    loadAverage: 0,
    memoryAvailableMib: 6144,
    diskBudgetMib,
    diskHeldMib,
    channelProtocol: 24,
    createdAt: 0,
    updatedAt: 0,
  });
  const full = { ...HOST, hostId: "full", name: "full" };
  const roomy = { ...HOST, hostId: "roomy", name: "roomy" };
  const busier = { ...HOST, hostId: "busier", name: "busier" };
  const refused = placeSession([full], [usage("full", 70_000, 65_536)], AMD64_IMAGES, BOX, false, []);
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
        false,
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
        false,
        [],
      ),
    ),
    "roomy",
  );
  assert.equal(placed(placeSession([full], [usage("full", 10_000, 0)], AMD64_IMAGES, BOX, false, [])), "full");
});

test("a placement refusal captures each host's name and reason: Full, NoDisk, NoImage, NotOnline", () => {
  const usage = (
    hostId: string,
    boxCapacity: number,
    boxesRunning: number,
    memoryAvailableMib: number,
    diskBudgetMib: number,
    diskHeldMib: number,
  ) => ({
    hostId,
    tenantId: "tenant-placement",
    boxCapacity,
    boxesRunning,
    boxesWarm: 0,
    loadAverage: 0,
    memoryAvailableMib,
    diskBudgetMib,
    diskHeldMib,
    channelProtocol: 24,
    createdAt: 0,
    updatedAt: 0,
  });
  const hosts: Host[] = [
    { ...HOST, hostId: "big", name: "example-host" },
    { ...HOST, hostId: "small", name: "tumpel" },
    { ...HOST, hostId: "arm", name: "arm-box", architecture: "Arm64" },
    { ...HOST, hostId: "gone", name: "offline-box", state: "Offline" },
  ];
  const usages = [usage("big", 7, 7, 43000, 330000, 65536), usage("small", 1, 0, 4000, 21000, 19000)];
  const placement = placeSession(hosts, usages, AMD64_IMAGES, BOX, false, []);
  assert.equal(placement.kind, "Refused");
  if (placement.kind !== "Refused") return;
  const reasons = placement.hosts.map(({ host, reason }) => [host.name, reason]);
  assert.deepEqual(reasons, [
    ["example-host", "Full"],
    ["tumpel", "NoDisk"],
    ["arm-box", "NoImage"],
    ["offline-box", "NotOnline"],
  ]);
});

test("a host reporting a memory budget is refused only when the box's memory does not fit it, whatever its box slots; one without falls back to its slots", () => {
  const usage = (hostId: string, memory: { memoryBudgetMib: number; memoryHeldMib: number } | object) => ({
    hostId,
    tenantId: "tenant-placement",
    boxCapacity: 2,
    boxesRunning: 5,
    boxesWarm: 0,
    loadAverage: 0,
    memoryAvailableMib: 6144,
    channelProtocol: 27,
    createdAt: 0,
    updatedAt: 0,
    ...memory,
  });
  const fits = { ...HOST, hostId: "fits", name: "fits" };
  const tight = { ...HOST, hostId: "tight", name: "tight" };
  const slots = { ...HOST, hostId: "slots", name: "slots" };
  const box = { boxMemoryMib: 2048, boxDiskMib: BoxDiskLimit.DefaultMib };
  const placement = placeSession(
    [tight, slots, fits],
    [
      usage("tight", { memoryBudgetMib: 10240, memoryHeldMib: 8193 }),
      usage("slots", {}),
      usage("fits", { memoryBudgetMib: 10240, memoryHeldMib: 8192 }),
    ],
    AMD64_IMAGES,
    box,
    false,
    [],
  );
  assert.equal(placed(placement), "fits");
  const refused = placeSession(
    [tight, slots],
    [usage("tight", { memoryBudgetMib: 10240, memoryHeldMib: 8193 }), usage("slots", {})],
    AMD64_IMAGES,
    box,
    false,
    [],
  );
  assert.deepEqual(
    refused.kind === "Refused" ? refused.hosts.map(({ host, reason }) => [host.name, reason]) : refused,
    [
      ["tight", "MemoryFull"],
      ["slots", "Full"],
    ],
  );
});

const EMPTY = {
  tenantId: "tenant-placement",
  boxesRunning: 0,
  boxesWarm: 0,
  loadAverage: 0,
  memoryAvailableMib: 16_384,
  channelProtocol: 28,
  createdAt: 0,
  updatedAt: 0,
};

const heldBox = (sessionId: string, hostId: string, evictable: boolean, lastTurnEndedAt: number) => ({
  sessionId,
  hostId,
  evictable,
  lastTurnEndedAt,
  ...BOX,
});

test("a free slot on any host wins over evicting a warm box", () => {
  const hosts = [
    { ...HOST, hostId: "held", name: "held" },
    { ...HOST, hostId: "spare", name: "spare" },
  ];
  const usages = [
    { ...EMPTY, hostId: "held", boxCapacity: 1 },
    { ...EMPTY, hostId: "spare", boxCapacity: 1, loadAverage: 3.9 },
  ];
  const placement = placeSession(hosts, usages, AMD64_IMAGES, BOX, false, [heldBox("old", "held", true, 1)]);
  assert.deepEqual(placement.kind === "Placed" && [placement.host.name, placement.evict], ["spare", []]);
});

test("with no free slot the least recently used Auto box across hosts goes first", () => {
  const hosts = [
    { ...HOST, hostId: "a", name: "a" },
    { ...HOST, hostId: "b", name: "b" },
  ];
  const usages = [
    { ...EMPTY, hostId: "a", boxCapacity: 2 },
    { ...EMPTY, hostId: "b", boxCapacity: 1 },
  ];
  const held = [heldBox("a-new", "a", true, 30), heldBox("a-old", "a", true, 20), heldBox("b-oldest", "b", true, 10)];
  const placement = placeSession(hosts, usages, AMD64_IMAGES, BOX, false, held);
  assert.deepEqual(
    placement.kind === "Placed" && [placement.host.name, placement.evict.map((each) => each.sessionId)],
    ["b", ["b-oldest"]],
  );
});

test("a Warm box is never evicted, so a start beside only Warm and running boxes is refused Full", () => {
  const hosts = [
    { ...HOST, hostId: "warm", name: "warm" },
    { ...HOST, hostId: "busy", name: "busy" },
  ];
  const usages = [
    { ...EMPTY, hostId: "warm", boxCapacity: 1 },
    { ...EMPTY, hostId: "busy", boxCapacity: 1, boxesRunning: 1 },
  ];
  const placement = placeSession(hosts, usages, AMD64_IMAGES, BOX, false, [heldBox("kept", "warm", false, 1)]);
  assert.deepEqual(placement.kind === "Refused" && placement.hosts.map((each) => [each.host.name, each.reason]), [
    ["warm", "Full"],
    ["busy", "Full"],
  ]);
});

test("a host out of reserved memory evicts its oldest Auto box, never a Warm one, whatever its free slots", () => {
  const host = { ...HOST, hostId: "budget", name: "budget" };
  const usage = { ...EMPTY, hostId: "budget", boxCapacity: 8, memoryBudgetMib: 6144, memoryHeldMib: 6144 };
  const box = { ...BOX, boxMemoryMib: 2048 };
  const held = [
    { ...heldBox("warm", "budget", false, 1), boxMemoryMib: 2048 },
    { ...heldBox("auto-old", "budget", true, 2), boxMemoryMib: 2048 },
    { ...heldBox("auto-new", "budget", true, 3), boxMemoryMib: 2048 },
  ];
  const placement = placeSession([host], [usage], AMD64_IMAGES, box, false, held);
  assert.deepEqual(placement.kind === "Placed" && placement.evict.map((each) => each.sessionId), ["auto-old"]);
});
