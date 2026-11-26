import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol, HostFrameSchema, SessionSchema } from "@tumpel/schemas";
import { z } from "zod";
import { TENANT_OPERATIONS } from "../../src/tenant-api.ts";
import {
  DIGESTS_PER_PART,
  type Placement,
  releasesBoxes,
  sha256,
  storageKeyOf,
  storesTree,
  tree,
} from "./harness/snapshot-chunks.ts";
import { BUDGETS, PRINCIPAL_ID, TENANT_ID, UNMETERED, World } from "./harness/world.ts";

const BUDGET_MS = 30;
const CHILD_OPERATIONS = new Set(["listEvents", "listSessions"]);

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

const SESSIONS = 10;
const TURNS_PER_SESSION = 50;
const LINES_PER_TURN = 10;
const LONG_TRANSCRIPT_LINES = 2000;
const SUBSCRIPTIONS_PER_SESSION = 2;
const TREE_CHUNKS = 5000;
const RESULT = '{"type":"result","subtype":"success","is_error":false}';

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
  const pageCase = {
    kind: "Operation",
    operation: "listSessions",
    input: { tenantId: TENANT_ID, filter: { limit: 50 } },
  } as const;
  const ms = world.childMs(await world.seeded(), pageCase)[0] ?? Number.POSITIVE_INFINITY;
  console.log(`${ms.toFixed(2)} ms cold, ${first.rows} rows read`);
  assert.ok(ms <= BUDGET_MS, `a page of 50 took ${ms.toFixed(2)} ms`);

  await world.tick(1);
  for (let at = 60; at < 90; at++) {
    const session = await world.startSession({ prompt: `page session ${at}`, tags: [] });
    added.push(session.sessionId);
  }
  const grown = await rowsRead("/v1/sessions?limit=50");
  assert.deepEqual(grown.ids, first.ids);
  assert.equal(grown.rows, first.rows);
  const grownMs = world.childMs(await world.seeded(), pageCase)[0] ?? Number.POSITIVE_INFINITY;
  assert.ok(grownMs <= BUDGET_MS, `a page of 50 of 100 took ${grownMs.toFixed(2)} ms`);

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

test("a cold session list page of 50 on a tenant of 1400 sessions stays inside the budget and returns each session's last turn image and prebuild layer", {
  timeout: 900_000,
}, async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const claimed = await world.startSession({ prompt: "boot the copied session", tags: ["crew:copied"] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const sql = world.tenantSql();
  const copy = (table: string, key: string, from: string, replace: Record<string, string>) => {
    const columns = z
      .array(z.object({ name: z.string() }))
      .parse(sql.exec(`SELECT name FROM pragma_table_info('${table}')`).toArray())
      .map(({ name }) => name);
    sql.exec(
      `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${columns.map((name) => (replace[name] === undefined ? name : "?")).join(", ")} FROM ${table} WHERE ${key} = ?`,
      ...columns.flatMap((name) => replace[name] ?? []),
      from,
    );
  };
  const fullDigest = "f".repeat(64);
  const copies: { sessionId: string; image: "Full" | "Layered" | "None"; layered: boolean }[] = [];
  for (let at = 0; at < 1399; at++) {
    const sessionId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    copy("sessions", "session_id", claimed.sessionId, { session_id: sessionId });
    sql.exec("UPDATE sessions SET created_at = created_at + ? WHERE session_id = ?", at + 1, sessionId);
    copy("session_tags", "session_id", claimed.sessionId, { session_id: sessionId });
    copy("session_layer_absences", "session_id", claimed.sessionId, { session_id: sessionId });
    copy("turns", "turn_id", offer.turnId, { turn_id: turnId, session_id: sessionId });
    copy("turn_layered_images", "turn_id", offer.turnId, { turn_id: turnId });
    const image = at % 5 === 4 ? "None" : at % 2 === 1 ? "Full" : "Layered";
    if (image !== "Layered") sql.exec("DELETE FROM turn_layered_images WHERE turn_id = ?", turnId);
    if (image === "Full") {
      sql.exec(
        "INSERT INTO turn_full_images (turn_id, guest_image_digest, created_at) VALUES (?, ?, ?)",
        turnId,
        fullDigest,
        Date.now(),
      );
    }
    const layered = at % 3 !== 2;
    if (!layered) sql.exec("DELETE FROM session_layer_absences WHERE session_id = ?", sessionId);
    copies.push({ sessionId, image, layered });
  }
  const read = async (path: string) => {
    const answer = await world.fetch(world.owner, "GET", path);
    assert.equal(answer.status, 200, path);
    return answer.json();
  };
  const original = SessionSchema.parse(await read(`/v1/sessions/${claimed.sessionId}`));
  assert.equal(original.lastTurnImage?.kind, "Layered");
  assert.equal(original.prebuildLayer?.layer === "None" && original.prebuildLayer.reason, "NoPrebuild");
  const expected = new Map([
    [claimed.sessionId, { lastTurnImage: original.lastTurnImage, prebuildLayer: original.prebuildLayer }],
    ...copies.map(
      ({ sessionId, image, layered }) =>
        [
          sessionId,
          {
            lastTurnImage: {
              Full: { kind: "Full", guestImageDigest: fullDigest },
              Layered: original.lastTurnImage,
              None: undefined,
            }[image],
            prebuildLayer: layered ? original.prebuildLayer : undefined,
          },
        ] as const,
    ),
  ]);
  const ordered = [...expected.keys()];

  const ms =
    world.childMs(await world.seeded(), {
      kind: "Operation",
      operation: "listSessions",
      input: { tenantId: TENANT_ID, filter: { limit: 50 } },
    })[0] ?? Number.POSITIVE_INFINITY;
  const page = SessionSchema.array().parse(await read("/v1/sessions?limit=50"));
  console.log(`a cold page of 50 of 1400 sessions took ${ms.toFixed(2)} ms`);
  assert.deepEqual(
    page.map(({ sessionId }) => sessionId),
    ordered.slice(0, 50),
  );
  assert.deepEqual(
    page.map(({ sessionId, lastTurnImage, prebuildLayer, tags }) => ({
      sessionId,
      lastTurnImage,
      prebuildLayer,
      tags,
    })),
    ordered.slice(0, 50).map((sessionId) => ({ sessionId, ...expected.get(sessionId), tags: ["crew:copied"] })),
  );
  for (const session of page)
    assert.deepEqual(session, SessionSchema.parse(await read(`/v1/sessions/${session.sessionId}`)));
  assert.ok(ms <= BUDGET_MS, `a cold page of 50 of 1400 sessions took ${ms.toFixed(2)} ms`);
});

const DESTRUCTIVE = /^(delete|archive|forget|revoke|remove|stop|cancel|clear|purge|disconnect|restore)/;

type Result = { label: string; ms: number };

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
  const cold = CHILD_OPERATIONS.has(name)
    ? world
        .seeded()
        .then(
          (seeded) =>
            world.childMs(seeded, { kind: "Operation", operation: name, input })[0] ?? Number.POSITIVE_INFINITY,
        )
    : world.coldMs(name, input);
  const ms = await cold.catch((error: unknown) => {
    failed(error);
    return null;
  });
  if (ms !== null) results.push({ label, ms });
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
    if (["TelemetryBatch", "TurnLine"].includes(type)) continue;
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
  results.sort((a, b) => b.ms - a.ms);
  for (const { label, ms } of results) console.log(`${ms.toFixed(2).padStart(8)} ms cold  ${label}`);
  const over = results.filter(({ ms }) => ms > BUDGET_MS).map(({ label, ms }) => `${label}: ${ms.toFixed(2)} ms`);
  assert.deepEqual(over, [], `actions over ${BUDGET_MS} ms of compute`);
  assert.deepEqual(broken, [], `actions the test could not run:\n${broken.join("\n")}`);
});
test("every cleanup step, the delete step too, stays within the budget beside 20 open uploads, one naming 16384 packs, on a restarted tenant", {
  timeout: 300_000,
}, async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const sessions: string[] = [];
  for (const name of ["live", "archived"]) {
    const session = await world.startSession({ prompt: `build the ${name} tree`, tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    await storesTree(world, host, session.sessionId, tree(DIGESTS_PER_PART));
    sessions.push(session.sessionId);
  }
  const [live = "", archived = ""] = sessions;
  const largest = Array.from({ length: 16_384 }, (_, at) => sha256(`open pack ${at}`));
  const orphan = `${TENANT_ID}/packs/${sha256("orphan beside open uploads")}`;
  await world.store.put(orphan, "pack");
  await world.store.put(`${TENANT_ID}/packs/${largest[0]}`, "pack");
  await world.tick(61 * 60_000);
  for (let at = 0; at < 20; at++) {
    const storageKey = `${TENANT_ID}/snapshots/open-${at}`;
    world
      .tenantSql()
      .exec(
        "INSERT INTO snapshot_requests (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, created_at) SELECT ?, session_id, box_id, turn_id, ?, ?, ? FROM snapshots WHERE storage_key = ?",
        `open-${at}`,
        at + 100,
        storageKey,
        Date.now(),
        storageKeyOf(world, live),
      );
    const packs = at === 0 ? largest : Array.from({ length: 300 }, (_, pack) => sha256(`open ${at} pack ${pack}`));
    await world.store.put(`${storageKey}.draft`, JSON.stringify({ lastPart: 1, packs, reused: [] }));
  }
  await world.call("archiveSession", { tenantId: TENANT_ID, sessionId: archived, now: Date.now() });
  await world.tick(10 * 60_000);
  await world.restartTenant();

  const steps = world.childCleanupSteps(await world.seeded());
  while ((await world.alarmStep()) !== null);
  console.log(`cleanup beside 20 open uploads: ${steps.map((ms) => ms.toFixed(2)).join(", ")} ms`);
  assert.ok(Math.max(...steps) <= BUDGET_MS, `every step stays within ${BUDGET_MS} ms: ${steps.join(", ")}`);
  assert.equal(await world.store.head(orphan), null, "the old orphan goes");
  assert.notEqual(await world.store.head(`${TENANT_ID}/packs/${largest[0]}`), null, "an open upload's old pack stays");
});

test("a child times a small step under 10 ms while the parent holds a large heap", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const seeded = await world.seeded();
  const ballast = Array.from({ length: 3_000_000 }, (_, at) => ({ at, text: `ballast ${at}` }));

  const input = { tenantId: TENANT_ID, afterEventId: null, events: [], sessionId: null, triggerId: null };
  const [ms] = world.childMs(seeded, { kind: "Operation", operation: "listEvents", input });

  console.log(`listEvents in a child beside ${ballast.length} parent objects: ${ms?.toFixed(2)} ms`);
  assert.ok(ms !== undefined && ms < 10, `the child step took ${ms} ms`);
});
