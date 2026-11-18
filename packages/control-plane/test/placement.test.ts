import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxMemoryLimit } from "@tumpel/schemas";
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

const BOX_MEMORY_MIB = BoxMemoryLimit.DefaultMib;

const placed = (placement: Placement): string => {
  assert.equal(placement.kind, "Placed", JSON.stringify(placement));
  return placement.kind === "Placed" ? placement.host.name : "";
};

test("a session goes to the online host with the most free box slots, ignoring offline and full hosts", () => {
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
  assert.equal(placed(placeSession(hosts, usages, AMD64_IMAGES, BOX_MEMORY_MIB)), "freer");
});

test("equal free slots go to the host with the most memory available, and warm slots count as taken", () => {
  const hosts: Host[] = [
    { ...HOST, hostId: "pi", name: "pi" },
    { ...HOST, hostId: "pentium", name: "pentium" },
  ];
  const pi = {
    hostId: "pi",
    tenantId: "tenant-placement",
    boxCapacity: 2,
    boxesRunning: 0,
    boxesWarm: 0,
    loadAverage: 0.1,
    memoryAvailableMib: 900,
    channelProtocol: 18,
    createdAt: 0,
    updatedAt: 0,
  };
  const pentium = {
    hostId: "pentium",
    tenantId: "tenant-placement",
    boxCapacity: 4,
    boxesRunning: 0,
    boxesWarm: 2,
    loadAverage: 1.5,
    memoryAvailableMib: 3000,
    channelProtocol: 18,
    createdAt: 0,
    updatedAt: 0,
  };
  assert.equal(placed(placeSession(hosts, [pi, pentium], AMD64_IMAGES, BOX_MEMORY_MIB)), "pentium");
  assert.equal(placed(placeSession(hosts, [pi, { ...pentium, boxesWarm: 3 }], AMD64_IMAGES, BOX_MEMORY_MIB)), "pi");
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
    placed(placeSession([{ ...HOST, hostId: "warm", name: "warm" }], [usage], AMD64_IMAGES, BOX_MEMORY_MIB)),
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
  const placement = placeSession(hosts, [full], AMD64_IMAGES, BOX_MEMORY_MIB);
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
    const placement = placeSession([HOST], [usage], image, BOX_MEMORY_MIB);
    assert.deepEqual(
      placement.kind === "Refused"
        ? placement.hosts.map((each) => [each.reason, each.reason === "NoImage" ? [...each.image.architectures] : []])
        : placement,
      [["NoImage", architectures]],
    );
  }
  assert.equal(placed(placeSession([{ ...HOST, architecture: "Arm64" }], [usage], arm, BOX_MEMORY_MIB)), "base");
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
  const refused = placeSession([small], [usage("small", 6144)], AMD64_IMAGES, 8192);
  assert.deepEqual(
    refused.kind === "Refused"
      ? refused.hosts.map((each) => [each.reason, each.reason === "NoMemory" ? each.boxMemoryMib : 0])
      : refused,
    [["NoMemory", 8192]],
  );
  assert.equal(
    placed(placeSession([small, large], [usage("small", 6144), usage("large", 16384)], AMD64_IMAGES, 8192)),
    "large",
  );
});
