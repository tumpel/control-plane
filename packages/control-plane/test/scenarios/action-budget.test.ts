import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { HostFrameSchema } from "@tumpel/schemas";
import { z } from "zod";
import { STORED_FRAMES_PROTOCOL } from "../../src/channel/protocol.ts";
import { TENANT_OPERATIONS } from "../../src/tenant-api.ts";
import { BUDGETS, type Host, PRINCIPAL_ID, TENANT_ID, UNMETERED, World } from "./harness/world.ts";

const BUDGET_MS = 30;
const WARM_UPS = 8;
const RUNS = 5;

type Def = { type: string } & Record<string, unknown>;
type Known = Record<string, unknown>;

const STRINGS = [
  "x",
  "00000000-0000-4000-8000-000000000000",
  "https://scenario.test/x",
  "2026-11-21T11:00:00.000Z",
  "a".repeat(64),
  "x@scenario.test",
  "main",
  "A",
  "gh/acme/app",
  "a".repeat(87),
  ".github/workflows/ci.yml",
  "tenant_abc",
  "a".repeat(22),
];

const defOf = (schema: unknown): Def => (schema as { _zod: { def: Def } })._zod.def;

const generate = (schema: unknown, known: Known, key: string): unknown => {
  const def = defOf(schema);
  const accepts = (value: unknown) => (schema as z.ZodType).safeParse(value).success;
  const first = (candidates: unknown[]) => {
    const found = candidates.find(accepts);
    if (found === undefined) throw new Error(`no value for ${def.type} at ${key}`);
    return found;
  };
  if (key in known && accepts(known[key])) return known[key];
  switch (def.type) {
    case "string":
      return first(STRINGS);
    case "number":
    case "int": {
      const limits = ((def.checks ?? []) as { _zod: { def: { value?: unknown } } }[]).flatMap((check) => {
        const value = check._zod.def.value;
        return typeof value === "number" ? [value, value + 1, value - 1] : [];
      });
      return first([...limits, 1, 0, 2, 8, 100, 1024, 4096, 65536, Date.now()]);
    }
    case "boolean":
      return first([true, false]);
    case "enum":
      return Object.values(def.entries as Record<string, unknown>)[0];
    case "literal":
      return (def.values as unknown[])[0];
    case "null":
      return null;
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(def.shape as Record<string, unknown>)) {
        if (defOf(field).type === "optional") continue;
        out[name] = generate(field, known, name);
      }
      return out;
    }
    case "array": {
      if (accepts([])) return [];
      return [generate(def.element, known, key)];
    }
    case "record":
      return {};
    case "optional":
      return generate(def.innerType, known, key);
    case "nullable":
      return generate(def.innerType, known, key);
    case "default":
    case "readonly":
    case "catch":
    case "nonoptional":
      return generate(def.innerType, known, key);
    case "pipe":
      return generate(def.in, known, key);
    case "lazy":
      return generate((def.getter as () => unknown)(), known, key);
    case "union": {
      for (const option of def.options as unknown[]) {
        const value = generate(option, known, key);
        if (accepts(value)) return value;
      }
      throw new Error(`no union member accepts a generated value at ${key}`);
    }
    case "intersection":
      return { ...(generate(def.left, known, key) as object), ...(generate(def.right, known, key) as object) };
    default:
      return first([undefined, null, {}, [], "x", 1]);
  }
};

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

type Timing = { median: number; first: number };

const measured = async (action: () => Promise<number>): Promise<Timing> => {
  const first = await action();
  for (let at = 0; at < WARM_UPS; at++) await action();
  const runs: number[] = [];
  for (let at = 0; at < RUNS; at++) runs.push(await action());
  return { median: median(runs), first };
};

const SESSIONS = 10;
const TURNS_PER_SESSION = 50;
const LINES_PER_TURN = 10;
const LONG_TRANSCRIPT_LINES = 2000;
const SUBSCRIPTIONS_PER_SESSION = 2;
const CHUNK_BYTES = 65_536;
const DIGESTS_PER_PART = 500;
const TREE_CHUNKS = 5000;
const RESULT = '{"type":"result","subtype":"success","is_error":false}';

type Placement = { digest: string; packDigest: string; offset: number; length: number };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const tree = (count: number): Placement[] =>
  Array.from({ length: count }, (_, at) => ({
    digest: sha256(`tree chunk ${at}`),
    packDigest: sha256(`tree pack ${Math.floor(at / DIGESTS_PER_PART)}`),
    offset: (at % DIGESTS_PER_PART) * CHUNK_BYTES,
    length: CHUNK_BYTES,
  }));

const storesTree = async (world: World, host: Host, sessionId: string, chunks: Placement[]): Promise<void> => {
  const request = z
    .object({ snapshotId: z.string(), sessionId: z.string(), storageKey: z.string() })
    .parse(host.take("SnapshotRequest"));
  assert.equal(request.sessionId, sessionId);
  for (let at = 0; at * DIGESTS_PER_PART < chunks.length; at++) {
    const part = chunks.slice(at * DIGESTS_PER_PART, (at + 1) * DIGESTS_PER_PART);
    const packDigest = part[0]?.packDigest ?? "";
    await host.says({
      type: "SnapshotChunks",
      snapshotId: request.snapshotId,
      part: at + 1,
      digests: part.map((chunk) => chunk.digest),
    });
    const answer = z.object({ reply: z.object({ uploads: z.array(z.object({ packDigest: z.string() })) }) }).parse(
      await host.says({
        type: "SnapshotPacks",
        snapshotId: request.snapshotId,
        part: at + 1,
        packs: [{ packDigest, sizeBytes: part.length * CHUNK_BYTES }],
        chunks: part,
      }),
    );
    for (const upload of answer.reply.uploads) await world.store.put(`${TENANT_ID}/packs/${upload.packDigest}`, "pack");
  }
  const manifest = JSON.stringify({
    entries: [
      {
        kind: "File",
        path: "tree",
        mode: 420,
        uid: 0,
        gid: 0,
        mtimeSeconds: 0,
        mtimeNanos: 0,
        sizeBytes: chunks.length * CHUNK_BYTES,
        chunks,
      },
    ],
  });
  const digest = sha256(manifest);
  await world.store.put(`${TENANT_ID}/packs/${digest}`, manifest);
  await world.store.put(
    request.storageKey,
    JSON.stringify({ manifest: [{ digest, packDigest: digest, offset: 0, length: manifest.length }] }),
  );
  await host.says({
    type: "SnapshotDone",
    snapshotId: request.snapshotId,
    uploadedBytes: chunks.length * CHUNK_BYTES,
  });
};

const releasesBoxes = async (host: Host): Promise<void> => {
  while (host.received("BoxTeardown").length > 0) {
    const teardown = z.object({ sessionId: z.string(), boxId: z.string() }).parse(host.take("BoxTeardown"));
    await host.says({ type: "BoxGone", sessionId: teardown.sessionId, boxId: teardown.boxId });
  }
};

const camel = (column: string): string => column.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

const loadedIds = (world: World): Known => {
  const found: Known = {};
  for (const sql of [world.tenantSql(), world.db.sql]) {
    const tables = z
      .array(z.object({ name: z.string() }))
      .parse(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray());
    for (const { name: table } of tables) {
      const columns = z.array(z.object({ name: z.string() })).parse(sql.exec(`PRAGMA table_info(${table})`).toArray());
      for (const { name: column } of columns) {
        const key = camel(column);
        if (key in found || !/(Id|Digest|Seq|Hash)$/.test(key)) continue;
        const [row] = sql.exec(`SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`).toArray();
        if (row !== undefined) found[key] = row.value;
      }
    }
  }
  return found;
};

const seeded = async (t: { after(fn: () => void): void }) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.call("hostHello", {
    tenantId: TENANT_ID,
    hostId: host.hostId,
    heldTurnIds: [],
    boxCapacity: 64,
    usage: { boxesWarm: 0, loadAverage: 0, memoryAvailableMib: 30000, ...BUDGETS },
    now: Date.now(),
    channelProtocol: STORED_FRAMES_PROTOCOL,
  });
  const lineSeqs = new Map<string, number>();
  const runTurn = async (sessionId: string, lines: number, chunks: Placement[] | null): Promise<void> => {
    const offer = host.takeOffer();
    await host.claims(offer);
    const first = lineSeqs.get(sessionId) ?? 0;
    for (let at = 1; at <= lines; at++) {
      await host.says({
        type: "TurnLines",
        turnId: offer.turnId,
        firstLineSeq: first + at,
        lines: [`{"type":"assistant","n":${first + at}}`],
      });
    }
    const last = first + lines + 1;
    lineSeqs.set(sessionId, last);
    await host.says({ type: "TurnLines", turnId: offer.turnId, firstLineSeq: last, lines: [RESULT] });
    await host.says({
      type: "TurnComplete",
      turnId: offer.turnId,
      lastLineSeq: last,
      completedAt: new Date(Date.now()).toISOString(),
    });
    if (chunks === null) await host.answersSnapshot(sessionId);
    else await storesTree(world, host, sessionId, chunks);
    await releasesBoxes(host);
  };
  await world.holdsAgentCredentials();
  const sessions: string[] = [];
  for (let at = 0; at < SESSIONS; at++) {
    const session = await world.startSession({
      prompt: `budget session ${at}`,
      tags: at === 0 ? ["role:foreman"] : [],
    });
    sessions.push(session.sessionId);
    await runTurn(session.sessionId, at === 0 ? LONG_TRANSCRIPT_LINES : LINES_PER_TURN, null);
    for (let turn = 1; turn < TURNS_PER_SESSION; turn++) {
      await world.sendTurn(session.sessionId, `turn ${turn}`);
      const last = at === 0 && turn === TURNS_PER_SESSION - 1;
      await runTurn(session.sessionId, LINES_PER_TURN, last ? tree(TREE_CHUNKS) : null);
    }
  }
  for (const [at, sessionId] of sessions.entries()) {
    const session = await world.session(sessionId);
    for (let each = 0; each < SUBSCRIPTIONS_PER_SESSION; each++) {
      await world.subscribe(session, {
        prompt: `hand out step ${each}`,
        goal: "the epic is merged",
        events: ["TurnFailed"],
        crewTags: [`crew:${at}-${each}`],
      });
    }
  }
  const known: Known = { ...loadedIds(world), tenantId: TENANT_ID, principalId: PRINCIPAL_ID, now: Date.now() };
  const events = z
    .array(z.object({ total: z.number() }))
    .parse(world.tenantSql().exec("SELECT count(*) AS total FROM events").toArray());
  console.log(`seeded ${sessions.length} sessions, ${events[0]?.total ?? 0} events`);
  return { world, known };
};

const DESTRUCTIVE = /^(delete|archive|forget|revoke|remove|stop|cancel|clear|purge|disconnect|restore)/;

type Result = { label: string; timing: Timing };

const timed = async (
  world: World,
  name: string,
  build: () => unknown,
  results: Result[],
  broken: string[],
  label = name,
): Promise<void> => {
  const failed = (error: unknown) => broken.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  let input: unknown;
  try {
    input = build();
  } catch (error) {
    failed(error);
    return;
  }
  const timing = await measured(() => world.computeMs(name, input)).catch((error: unknown) => {
    failed(error);
    return null;
  });
  if (timing !== null) results.push({ label, timing });
};

test("every Tenant API operation and host frame computes within the 30 ms budget on a loaded tenant", {
  timeout: 900_000,
}, async (t) => {
  const { world, known } = await seeded(t);
  const results: Result[] = [];
  const broken: string[] = [];
  const operations = Object.entries(TENANT_OPERATIONS)
    .filter(([name]) => name !== "hostMessage")
    .sort(([a], [b]) => Number(DESTRUCTIVE.test(a)) - Number(DESTRUCTIVE.test(b)));
  for (const [name, operation] of operations) {
    await timed(world, name, () => generate(operation.input, known, name), results, broken);
  }
  const members = HostFrameSchema.shape.message as unknown as z.ZodType as unknown;
  for (const option of defOf(members).options as unknown[]) {
    const type = String((defOf((defOf(option).shape as Record<string, unknown>).type).values as unknown[])[0]);
    if (type === "TelemetryBatch" || type === "TurnLine") continue;
    const operation =
      type === "SupervisorUpdateStep" || type === "SupervisorUpdateFailed" ? "supervisorUpdate" : "hostMessage";
    await timed(
      world,
      operation,
      () => {
        const message = generate(option, known, "message");
        if (operation === "supervisorUpdate") return { hostId: known.hostId, message };
        return { tenantId: TENANT_ID, hostId: known.hostId, message };
      },
      results,
      broken,
      `frame ${type}`,
    );
  }
  results.sort((a, b) => b.timing.median - a.timing.median);
  for (const { label, timing } of results) {
    console.log(
      `${timing.median.toFixed(2).padStart(8)} ms median  ${timing.first.toFixed(2).padStart(8)} ms first  ${label}`,
    );
  }
  const over = results.filter(({ timing }) => timing.median > BUDGET_MS).map(({ label }) => label);
  assert.deepEqual(over, [], `actions over ${BUDGET_MS} ms of compute`);
  assert.deepEqual(broken, [], `actions the test could not run:\n${broken.join("\n")}`);
});
