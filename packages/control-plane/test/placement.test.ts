import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { placeSession } from "../src/placement.ts";

type Host = z.infer<typeof HostSchema>;

const host = (name: string, state: Host["state"], usage?: Partial<NonNullable<Host["usage"]>>): Host => ({
  hostId: `host-${name}`,
  tenantId: "tenant-placement",
  name,
  state,
  architecture: "Amd64",
  cpuCount: 4,
  memoryBytes: 8 * 1024 ** 3,
  publicKey: "key",
  supervisorVersion: "0.1.0",
  labels: [],
  ...(usage === undefined
    ? {}
    : {
        usage: {
          architecture: "Amd64",
          boxCapacity: 8,
          boxesRunning: 0,
          boxesWarm: 0,
          cpuCount: 4,
          loadAverage: 0.5,
          memoryTotalMib: 8192,
          memoryAvailableMib: 4096,
          heartbeatAt: "2026-11-15T10:00:00.000Z",
          ...usage,
        },
      }),
  createdAt: 0,
  updatedAt: 0,
});

const placed = (hosts: Host[]): string => {
  const placement = placeSession(hosts, ["Amd64"]);
  assert.equal(placement.kind, "Placed", JSON.stringify(placement));
  return placement.kind === "Placed" ? placement.host.name : "";
};

test("a session goes to the online host with the most free box slots, ignoring offline and full hosts", () => {
  const full = host("full", "Online", { boxCapacity: 4, boxesRunning: 4 });
  const free = host("free", "Online", { boxCapacity: 8, boxesRunning: 3, boxesWarm: 2 });
  const freer = host("freer", "Online", { boxCapacity: 6, boxesRunning: 1 });
  const offline = host("offline", "Offline", { boxCapacity: 256 });
  assert.equal(placed([offline, full, free, freer]), "freer");
});

test("equal free slots go to the host with the most memory available, and warm slots count as taken", () => {
  const pi = host("pi", "Online", { boxCapacity: 2, memoryAvailableMib: 900 });
  const pentium = host("pentium", "Online", { boxCapacity: 4, boxesWarm: 2, memoryAvailableMib: 3000 });
  assert.equal(placed([pi, pentium]), "pentium");
  assert.equal(placed([pi, host("pentium", "Online", { boxCapacity: 4, boxesWarm: 3 })]), "pi");
});

test("a host whose every slot is warm still takes a session, since the supervisor evicts a warm box", () => {
  assert.equal(placed([host("warm", "Online", { boxCapacity: 2, boxesWarm: 2 })]), "warm");
});

test("a tenant whose hosts all run a turn in every slot is refused with each host's reason", () => {
  const placement = placeSession(
    [
      host("full", "Online", { boxCapacity: 2, boxesRunning: 2 }),
      host("arm", "Online", { architecture: "Arm64" }),
      host("silent", "Online"),
      host("gone", "Offline", {}),
    ],
    ["Amd64"],
  );
  assert.deepEqual(
    placement.kind === "Refused" ? placement.hosts.map(({ host: refused, reason }) => [refused.name, reason]) : [],
    [
      ["full", "Full"],
      ["arm", "NoImage"],
      ["silent", "NoUsage"],
      ["gone", "NotOnline"],
    ],
  );
});
