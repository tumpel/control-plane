import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostSchema } from "@tumpel/api/schemas";
import type { z } from "zod";
import { type ImageAvailability, type Placement, placeSession } from "../src/placement.ts";
import { imagesFor, type ReleaseRead } from "../src/releases.ts";

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

const AMD64_IMAGES: ImageAvailability = { harness: "ClaudeCode", harnessVersion: "2.0.0", architectures: ["Amd64"] };

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
  assert.equal(placed(placeSession(hosts, usages, AMD64_IMAGES)), "freer");
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
  assert.equal(placed(placeSession(hosts, [pi, pentium], AMD64_IMAGES)), "pentium");
  assert.equal(placed(placeSession(hosts, [pi, { ...pentium, boxesWarm: 3 }], AMD64_IMAGES)), "pi");
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
  assert.equal(placed(placeSession([{ ...HOST, hostId: "warm", name: "warm" }], [usage], AMD64_IMAGES)), "warm");
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
  const placement = placeSession(hosts, [full], AMD64_IMAGES);
  assert.deepEqual(placement.kind === "Refused" ? placement.hosts.map(({ host, reason }) => [host.name, reason]) : [], [
    ["full", "Full"],
    ["arm", "NoImage"],
    ["gone", "NotOnline"],
  ]);
});

test("a host whose architecture has no image of the session's harness version in the current release is refused NoImage", () => {
  const digest = (char: string): string => char.repeat(64);
  const s3 = "https://account.r2.cloudflarestorage.com/tumpel-releases";
  const release: ReleaseRead = {
    kind: "Published",
    manifest: {
      releaseVersion: "0.2.0",
      commit: "e".repeat(40),
      channelProtocolVersion: 8,
      supervisors: [
        { architecture: "Arm64", url: `${s3}/supervisor/arm64/${digest("a")}`, sha256: digest("a"), sizeBytes: 1 },
      ],
      images: [
        {
          harness: "ClaudeCode",
          harnessVersion: "2.0.0",
          architecture: "Arm64",
          imageUrl: `${s3}/images/ClaudeCode/2.0.0/arm64/${digest("b")}`,
          imageDigest: digest("b"),
          kernelUrl: `${s3}/kernels/arm64/${digest("c")}`,
          kernelDigest: digest("c"),
          manifestDigest: digest("d"),
        },
      ],
    },
  };
  const usage = {
    hostId: HOST.hostId,
    tenantId: "tenant-placement",
    boxCapacity: 4,
    boxesRunning: 0,
    boxesWarm: 0,
    loadAverage: 0,
    memoryAvailableMib: 4096,
    createdAt: 0,
    updatedAt: 0,
  };
  const availability = (harnessVersion: string, read: ReleaseRead): ImageAvailability => ({
    harness: "ClaudeCode",
    harnessVersion,
    architectures: imagesFor(read, "ClaudeCode", harnessVersion).map((image) => image.architecture),
  });
  const cases: [ImageAvailability, string[]][] = [
    [availability("2.0.0", release), ["Arm64"]],
    [availability("1.9.0", release), []],
    [availability("2.0.0", { kind: "Unpublished" }), []],
  ];
  for (const [image, architectures] of cases) {
    const placement = placeSession([HOST], [usage], image);
    assert.deepEqual(
      placement.kind === "Refused"
        ? placement.hosts.map((each) => [each.reason, each.reason === "NoImage" ? [...each.image.architectures] : []])
        : placement,
      [["NoImage", architectures]],
    );
  }
  assert.equal(
    placed(placeSession([{ ...HOST, architecture: "Arm64" }], [usage], availability("2.0.0", release))),
    "base",
  );
});
