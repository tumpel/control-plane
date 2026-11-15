import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { placeSession, placeTurn, type TurnPlacement } from "../src/placement.ts";

type Host = z.infer<typeof HostSchema>;

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

const placed = (placement: TurnPlacement): string => {
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
      createdAt: 0,
      updatedAt: 0,
    },
  ];
  assert.equal(placed(placeSession(hosts, usages, ["Amd64"])), "freer");
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
    createdAt: 0,
    updatedAt: 0,
  };
  assert.equal(placed(placeSession(hosts, [pi, pentium], ["Amd64"])), "pentium");
  assert.equal(placed(placeSession(hosts, [pi, { ...pentium, boxesWarm: 3 }], ["Amd64"])), "pi");
});

test("a host whose every slot is warm still takes a session, since the supervisor evicts a warm box", () => {
  const usage = {
    hostId: "warm",
    tenantId: "tenant-placement",
    boxCapacity: 2,
    boxesRunning: 0,
    boxesWarm: 2,
    loadAverage: 0.2,
    memoryAvailableMib: 1024,
    createdAt: 0,
    updatedAt: 0,
  };
  assert.equal(placed(placeSession([{ ...HOST, hostId: "warm", name: "warm" }], [usage], ["Amd64"])), "warm");
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
    createdAt: 0,
    updatedAt: 0,
  };
  const placement = placeSession(hosts, [full], ["Amd64"]);
  assert.deepEqual(placement.kind === "Refused" ? placement.hosts.map(({ host, reason }) => [host.name, reason]) : [], [
    ["full", "Full"],
    ["arm", "NoImage"],
    ["gone", "NotOnline"],
  ]);
});

test("a turn of a session whose host is offline moves to another online host when a snapshot holds its last completed turn", () => {
  const hosts: Host[] = [
    { ...HOST, hostId: "lost", name: "lost", state: "Offline" },
    { ...HOST, hostId: "spare", name: "spare" },
  ];
  const spare = {
    hostId: "spare",
    tenantId: "tenant-placement",
    boxCapacity: 4,
    boxesRunning: 1,
    boxesWarm: 0,
    loadAverage: 0.5,
    memoryAvailableMib: 4096,
    createdAt: 0,
    updatedAt: 0,
  };
  const placement = placeTurn("lost", hosts, [spare], ["Amd64"], ["turn-1", "turn-2"], new Set(["turn-2"]));
  assert.equal(placed(placement), "spare");
});

test("a turn of a session whose host is offline is stranded, naming the completed turns no snapshot holds", () => {
  const hosts: Host[] = [
    { ...HOST, hostId: "lost", name: "lost", state: "Offline" },
    { ...HOST, hostId: "spare", name: "spare" },
  ];
  const spare = {
    hostId: "spare",
    tenantId: "tenant-placement",
    boxCapacity: 4,
    boxesRunning: 0,
    boxesWarm: 0,
    loadAverage: 0.5,
    memoryAvailableMib: 4096,
    createdAt: 0,
    updatedAt: 0,
  };
  assert.deepEqual(placeTurn("lost", hosts, [spare], ["Amd64"], ["turn-1", "turn-2", "turn-3"], new Set(["turn-1"])), {
    kind: "Stranded",
    missingTurnIds: ["turn-2", "turn-3"],
  });
});
