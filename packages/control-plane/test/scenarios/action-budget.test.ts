import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ChannelProtocol, HostFrameSchema, SessionSchema } from "@tumpel/schemas";
import { z } from "zod";
import { turnCredentialSeconds } from "../../src/settings.ts";
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
const RESTORED_CHUNKS = 200_000;
const RESULT = '{"type":"result","subtype":"success","is_error":false}';

type Placement = { digest: string; packDigest: string; offset: number; length: number };

const RestoreReplySchema = z.object({
  reply: z.object({
    type: z.literal("RestoreDownloads"),
    packs: z.array(z.object({ packDigest: z.string(), url: z.string() })),
  }),
});

const partsOf = (chunks: Placement[]): Placement[][] =>
  Array.from({ length: Math.ceil(chunks.length / DIGESTS_PER_PART) }, (_, at) =>
    chunks.slice(at * DIGESTS_PER_PART, (at + 1) * DIGESTS_PER_PART),
  );

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const tree = (count: number): Placement[] =>
  Array.from({ length: count }, (_, at) => ({
    digest: sha256(`tree chunk ${at}`),
    packDigest: sha256(`tree pack ${Math.floor(at / DIGESTS_PER_PART)}`),
    offset: (at % DIGESTS_PER_PART) * CHUNK_BYTES,
    length: CHUNK_BYTES,
  }));

const storesTree = async (world: World, host: Host, sessionId: string, chunks: Placement[]): Promise<Placement> => {
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
        reusedPackDigests: [],
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
  const root = { digest, packDigest: digest, offset: 0, length: manifest.length };
  await world.store.put(`${TENANT_ID}/packs/${digest}`, manifest);
  await world.store.put(request.storageKey, JSON.stringify({ manifest: [root] }));
  await host.says({
    type: "SnapshotPacks",
    snapshotId: request.snapshotId,
    part: Math.ceil(chunks.length / DIGESTS_PER_PART) + 1,
    packs: [{ packDigest: digest, sizeBytes: manifest.length }],
    chunks: [root],
    reusedPackDigests: [],
  });
  await host.says({
    type: "SnapshotDone",
    snapshotId: request.snapshotId,
    uploadedBytes: chunks.length * CHUNK_BYTES,
    chunkCount: chunks.length,
  });
  return root;
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
    channelProtocol: ChannelProtocol.Oldest,
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
    const enabled = await world.fetch(
      world.owner,
      "PATCH",
      `/v1/personas/${session.personaId}`,
      JSON.stringify({ tumpelMcp: true }),
    );
    assert.equal(enabled.status, 200);
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
  return { world, known, host, sessions };
};

test("a host of the tenant gets the restore URLs of a 200000-chunk snapshot with no offered turn or open window, each part within the budget on a restarted tenant", {
  timeout: 900_000,
}, async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const chunks = tree(RESTORED_CHUNKS);
  const session = await world.startSession({ prompt: "build the large tree", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const root = await storesTree(world, host, session.sessionId, chunks);
  await releasesBoxes(host);
  const lost = chunks.at(-1)?.packDigest ?? "";
  await world.store.delete(`${TENANT_ID}/packs/${lost}`);
  await world.tick(turnCredentialSeconds(world.settings) * 1000);
  await world.restartTenant();

  const asked = [[root], ...partsOf(chunks)];
  const spent: number[] = [];
  for (const [at, part] of asked.entries()) {
    const input = {
      tenantId: TENANT_ID,
      hostId: host.hostId,
      message: { type: "RestoreChunks", turnId: offer.turnId, part: at + 1, chunks: part },
    };
    spent.push(await world.computeMs("hostMessage", input));
    const { reply } = RestoreReplySchema.parse(await world.call("hostMessage", input));
    const packs = [...new Set(part.map((chunk) => chunk.packDigest))].filter((packDigest) => packDigest !== lost);
    assert.deepEqual(
      reply.packs.map((pack) => pack.packDigest),
      packs,
      `part ${at + 1}`,
    );
    for (const pack of reply.packs) assert.match(pack.url, new RegExp(`/packs/${pack.packDigest}`));
  }
  console.log(`first part ${spent[0]?.toFixed(2)} ms, slowest ${Math.max(...spent).toFixed(2)} ms`);
  const over = spent.flatMap((ms, at) => (ms > BUDGET_MS ? [`part ${at + 1}: ${ms.toFixed(2)} ms`] : []));
  assert.deepEqual(over, [], `RestoreChunks parts over ${BUDGET_MS} ms of compute`);
});

test("a session list page stays inside the budget and reads no more rows as the tenant grows, and an unpaged list is refused", {
  timeout: 900_000,
}, async (t) => {
  const { world, host, sessions } = await seeded(t);
  await world.call("hostHello", {
    tenantId: TENANT_ID,
    hostId: host.hostId,
    heldTurnIds: [],
    boxCapacity: 100,
    usage: {
      ...BUDGETS,
      boxesWarm: 0,
      loadAverage: 0,
      memoryBudgetMib: 500_000,
      memoryAvailableMib: 500_000,
      diskBudgetMib: 5_000_000,
    },
    now: Date.now(),
    channelProtocol: ChannelProtocol.Oldest,
  });
  await world.tick(1);
  const added: string[] = [];
  for (let at = 0; at < 60; at++) {
    const session = await world.startSession({ prompt: `page session ${at}`, tags: [] });
    added.push(session.sessionId);
  }
  const exec = t.mock.method(world.tenantSql(), "exec");
  const rowsRead = async (path: string): Promise<{ ids: string[]; rows: number }> => {
    exec.mock.resetCalls();
    const listed = await world.fetch(world.owner, "GET", path);
    assert.equal(listed.status, 200);
    const ids = SessionSchema.array()
      .parse(await listed.json())
      .map(({ sessionId }) => sessionId);
    return { ids, rows: exec.mock.calls.reduce((sum, call) => sum + (call.result?.toArray().length ?? 0), 0) };
  };
  const ordered = [...sessions.toSorted(), ...added.toSorted()];

  const first = await rowsRead("/v1/sessions?limit=50");
  assert.deepEqual(first.ids, ordered.slice(0, 50));
  const timing = await measured(() => world.computeMs("listSessions", { tenantId: TENANT_ID, filter: { limit: 50 } }));
  console.log(`${timing.median.toFixed(2)} ms median, ${timing.first.toFixed(2)} ms first, ${first.rows} rows read`);
  assert.ok(timing.median <= BUDGET_MS, `a page of 50 took ${timing.median.toFixed(2)} ms`);

  await world.tick(1);
  for (let at = 60; at < 90; at++) {
    const session = await world.startSession({ prompt: `page session ${at}`, tags: [] });
    added.push(session.sessionId);
  }
  const grown = await rowsRead("/v1/sessions?limit=50");
  assert.deepEqual(grown.ids, first.ids);
  assert.equal(grown.rows, first.rows);
  const grownTiming = await measured(() =>
    world.computeMs("listSessions", { tenantId: TENANT_ID, filter: { limit: 50 } }),
  );
  assert.ok(grownTiming.median <= BUDGET_MS, `a page of 50 of 100 took ${grownTiming.median.toFixed(2)} ms`);

  const unpagedHttp = await world.fetch(world.owner, "GET", "/v1/sessions");
  assert.equal(unpagedHttp.status, 400);
  const unpagedDetail = z.object({ detail: z.string() }).parse(await unpagedHttp.json()).detail;
  assert.match(unpagedDetail, /^sessions\.list refused the query: limit: .*send limit \(1 to 50\), and after set to/);
  const unpagedMcp = await world.fetch(
    world.owner,
    "POST",
    "/mcp",
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tumpel_session_list", arguments: {} },
    }),
  );
  const mcpAnswer = z
    .object({ result: z.object({ content: z.array(z.object({ text: z.string() })), isError: z.literal(true) }) })
    .parse(await unpagedMcp.json());
  assert.match(
    mcpAnswer.result.content[0]?.text ?? "",
    /^tumpel_session_list refused its arguments: limit: .*send limit \(1 to 50\), and after set to/,
  );

  const paged: string[] = [];
  let page = grown.ids;
  while (page.length === 50) {
    paged.push(...page);
    page = (await rowsRead(`/v1/sessions?limit=50&after=${page.at(-1)}`)).ids;
  }
  paged.push(...page);
  assert.equal(paged.length, 100);
  assert.deepEqual(paged, [...ordered, ...added.slice(60).toSorted()]);

  const emptyPlan = JSON.stringify({
    config: { personas: [], secretSets: [], harnessPins: [], hosts: [] },
    files: [],
    expiryValues: [],
    secretValues: [],
  });
  const plan = await world.fetch(world.owner, "POST", "/v1/tenant-config/plan", emptyPlan);
  assert.equal(plan.status, 422);
  assert.ok(
    z
      .object({ detail: z.string() })
      .parse(await plan.json())
      .detail.includes(`still used by session ${paged.join(", ")}, which is neither Failed nor Archived`),
    "a config plan names every session past the first page",
  );

  const tenant = world.tenantSteps() as unknown as {
    listSessions(tenantId: string, filter: { after?: string }): Promise<unknown>;
  };
  const listSessions = tenant.listSessions.bind(tenant);
  const deleting = t.mock.method(tenant, "listSessions", (tenantId: string, filter: { after?: string }) => {
    if (filter.after !== undefined) world.tenantSql().exec("DELETE FROM sessions WHERE session_id = ?", filter.after);
    return listSessions(tenantId, filter);
  });
  const gone = await world.fetch(world.owner, "POST", "/v1/tenant-config/plan", emptyPlan);
  deleting.mock.restore();
  assert.equal(gone.status, 409);
  assert.deepEqual(z.object({ detail: z.string(), fix: z.string() }).parse(await gone.json()), {
    detail: `tenantConfigs.plan read the sessions page by page, and session ${paged[49]} was deleted before the next page`,
    fix: "Run it again",
  });

  const unknown = await world.fetch(world.owner, "GET", "/v1/sessions?limit=50&after=no-such-session");
  assert.equal(unknown.status, 400);
  assert.match(z.object({ detail: z.string() }).parse(await unknown.json()).detail, /^after names no-such-session/);
});

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
  const members = (defOf(HostFrameSchema.shape.message).getter as () => unknown)();
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

test("a chunk ask after a restart stays inside the budget, whatever the size of the previous snapshot", {
  timeout: 900_000,
}, async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  await world.holdsAgentCredentials();
  const session = await world.startSession({ prompt: "build a large tree", tags: [] });
  const chunks = tree(200_000);
  const first = host.takeOffer();
  await host.claims(first);
  await host.completes(first);
  await storesTree(world, host, session.sessionId, chunks);
  await releasesBoxes(host);
  await world.sendTurn(session.sessionId, "change one file");
  const second = host.takeOffer();
  await host.claims(second);
  await host.completes(second);
  const request = z.object({ snapshotId: z.string() }).parse(host.received("SnapshotRequest").at(-1));

  await world.restartTenant();
  const ms = await world.computeMs("hostMessage", {
    tenantId: TENANT_ID,
    hostId: host.hostId,
    message: {
      type: "SnapshotChunks",
      snapshotId: request.snapshotId,
      part: 1,
      digests: chunks.slice(0, DIGESTS_PER_PART).map((chunk) => chunk.digest),
    },
  });
  console.log(`${ms.toFixed(2)} ms for the first chunk ask after a restart`);
  assert.ok(ms <= BUDGET_MS, `the first chunk ask after a restart took ${ms.toFixed(2)} ms`);
});
