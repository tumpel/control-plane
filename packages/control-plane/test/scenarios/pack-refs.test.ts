import assert from "node:assert/strict";
import { test } from "node:test";
import { PackUploadsSchema, sha256, snapshotAsked, TENANT_ID } from "./harness/snapshot-chunks.ts";
import { type Host, UNMETERED, World } from "./harness/world.ts";

const BUDGET_MS = 30;
const SEEDED_SNAPSHOTS = 1400;
const LIVE_PACKS = 40_000;
const PACKS_PER_SNAPSHOT = 30;
const SNAPSHOT_STRIDE = 29;
const FIRST_PACKS = 280;
const PACKS_PER_PART = 10;
const KEPT_PACKS = 250;
const NEW_PACKS = 20;

type Request = { snapshotId: string; storageKey: string };
type Exec = { arguments: unknown[]; result?: { rowsWritten: number } };

const packsPart = (request: Request, part: number, packs: string[], reused: string[]) => ({
  type: "SnapshotPacks",
  snapshotId: request.snapshotId,
  part,
  packs: packs.map((packDigest) => ({ packDigest, sizeBytes: 8 })),
  chunks: packs.map((packDigest) => ({ digest: sha256(`chunk in ${packDigest}`), packDigest, offset: 0, length: 8 })),
  reusedPackDigests: reused,
});

const done = (request: Request) => ({
  type: "SnapshotDone",
  snapshotId: request.snapshotId,
  uploadedBytes: 8,
  chunkCount: 1,
});

const sendsParts = async (
  world: World,
  host: Host,
  request: Request,
  packs: string[],
  reused: string[],
): Promise<string[]> => {
  const root = sha256(`root of ${request.storageKey}`);
  await world.store.put(
    request.storageKey,
    JSON.stringify({ manifest: [{ digest: root, packDigest: root, offset: 0, length: 8 }] }),
  );
  const listed = [...packs, root];
  const uploads: string[] = [];
  for (let at = 0; at * PACKS_PER_PART < listed.length; at++) {
    const part = listed.slice(at * PACKS_PER_PART, (at + 1) * PACKS_PER_PART);
    const answer = PackUploadsSchema.parse(await host.says(packsPart(request, at + 1, part, at === 0 ? reused : [])));
    uploads.push(...answer.reply.uploads.map((upload) => upload.packDigest));
  }
  for (const packDigest of uploads) await world.store.put(`${TENANT_ID}/packs/${packDigest}`, "pack");
  return uploads;
};

const turnAsksSnapshot = async (
  world: World,
  host: Host,
  sessionId: string | null,
): Promise<Request & { sessionId: string }> => {
  const started = sessionId ?? (await world.startSession({ prompt: "build the tree", tags: [] })).sessionId;
  if (sessionId !== null) await world.sendTurn(sessionId, "next");
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  return { ...snapshotAsked(host, started), sessionId: started };
};

const refsOf = (world: World, packs: string[]): unknown[] =>
  world
    .tenantSql()
    .exec("SELECT refs FROM pack_refs JOIN json_each(?) ON value = pack_digest ORDER BY key", JSON.stringify(packs))
    .toArray()
    .map((row) => row.refs);

const inStore = async (world: World, packDigest: string): Promise<boolean> =>
  (await world.store.get(`${TENANT_ID}/packs/${packDigest}`)) !== null;

const seedsSnapshot = async (world: World, sessionId: string, seq: number, packs: string[]): Promise<string> => {
  const storageKey = `${TENANT_ID}/${sessionId}/snapshots/${String(seq).padStart(8, "0")}-seeded`;
  await world.store.put(`${storageKey}.packs`, JSON.stringify(packs.toSorted()));
  world
    .tenantSql()
    .exec(
      "INSERT INTO snapshots (snapshot_id, session_id, box_id, turn_id, snapshot_seq, storage_key, size_bytes, created_at, updated_at) VALUES (?, ?, 'seeded', 'seeded', ?, ?, 1, 0, 0)",
      `${sessionId}-${seq}`,
      sessionId,
      seq,
      storageKey,
    );
  return storageKey;
};

const frameMs = async (
  world: World,
  host: Host,
  calls: { calls: Exec[]; resetCalls(): void },
  message: unknown,
): Promise<{ ms: number; refs: number; holds: number }> => {
  calls.resetCalls();
  const ms = await world.computeMs("hostMessage", { tenantId: TENANT_ID, hostId: host.hostId, message });
  const written = (table: string) =>
    calls.calls
      .filter((call) => new RegExp(`^(INSERT INTO|UPDATE|DELETE FROM) ${table} `).test(String(call.arguments[0])))
      .reduce((sum, call) => sum + (call.result?.rowsWritten ?? 0), 0);
  return { ms, refs: written("pack_refs"), holds: written("pack_holds") };
};

test("a tenant of 1400 live snapshots and 40000 live packs takes a SnapshotPacks part and a SnapshotDone within 30 ms cold, writing only the packs whose count changes", {
  timeout: 300_000,
}, async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const counts = new Map<string, number>();
  const members: string[] = [];
  for (let at = 0; at < SEEDED_SNAPSHOTS; at++) {
    const packs = Array.from({ length: PACKS_PER_SNAPSHOT }, (_, each) =>
      sha256(`seeded pack ${(at * SNAPSHOT_STRIDE + each) % LIVE_PACKS}`),
    );
    for (const packDigest of packs) counts.set(packDigest, (counts.get(packDigest) ?? 0) + 1);
    members.push(await seedsSnapshot(world, "seeded", at + 1, packs));
  }
  assert.equal(counts.size, LIVE_PACKS);
  await world.store.put(`${TENANT_ID}/live-packs.json`, JSON.stringify({ members, counts: [...counts], held: [] }));
  world.tenantSql().exec("DELETE FROM pack_refs_imported");
  await world.restartTenant();
  assert.equal(await world.store.get(`${TENANT_ID}/live-packs.json`), null, "the import deletes the object");

  const first = await turnAsksSnapshot(world, host, null);
  const firstPacks = Array.from({ length: FIRST_PACKS }, (_, at) => sha256(`first pack ${at}`));
  await world.restartTenant();
  const exec = t.mock.method(world.tenantSql(), "exec");
  const part = await frameMs(world, host, exec.mock, packsPart(first, 1, firstPacks.slice(0, PACKS_PER_PART), []));
  console.log(`cold SnapshotPacks part: ${part.ms.toFixed(2)} ms, ${part.refs} counts, ${part.holds} holds written`);
  assert.ok(part.ms <= BUDGET_MS, `a cold SnapshotPacks part took ${part.ms.toFixed(2)} ms`);
  assert.deepEqual(
    [part.refs, part.holds],
    [PACKS_PER_PART, PACKS_PER_PART],
    "each new pack writes its count and hold",
  );

  await sendsParts(world, host, first, firstPacks, []);
  await world.restartTenant();
  const firstDone = await frameMs(world, host, exec.mock, done(first));
  console.log(
    `cold first SnapshotDone: ${firstDone.ms.toFixed(2)} ms, ${firstDone.refs} counts, ${firstDone.holds} holds`,
  );
  assert.ok(firstDone.ms <= BUDGET_MS, `a cold first SnapshotDone took ${firstDone.ms.toFixed(2)} ms`);
  assert.deepEqual([firstDone.refs, firstDone.holds], [0, FIRST_PACKS + 1], "the row takes over its holds' references");
  assert.deepEqual(refsOf(world, firstPacks), Array(FIRST_PACKS).fill(1));

  const second = await turnAsksSnapshot(world, host, first.sessionId);
  const added = Array.from({ length: NEW_PACKS }, (_, at) => sha256(`second pack ${at}`));
  await sendsParts(world, host, second, added, firstPacks.slice(0, KEPT_PACKS));
  await world.restartTenant();
  const secondDone = await frameMs(world, host, exec.mock, done(second));
  console.log(
    `cold second SnapshotDone: ${secondDone.ms.toFixed(2)} ms, ${secondDone.refs} counts, ${secondDone.holds} holds`,
  );
  assert.ok(secondDone.ms <= BUDGET_MS, `a cold second SnapshotDone took ${secondDone.ms.toFixed(2)} ms`);
  const dropped = FIRST_PACKS - KEPT_PACKS + 1;
  assert.deepEqual(
    [secondDone.refs, secondDone.holds],
    [2 * dropped, NEW_PACKS + 1],
    "it lowers each dropped pack and deletes its row once object storage drops it, and releases the new packs' holds",
  );
  assert.deepEqual(refsOf(world, firstPacks.slice(0, KEPT_PACKS)), Array(KEPT_PACKS).fill(1));
  assert.deepEqual(refsOf(world, firstPacks.slice(KEPT_PACKS)), []);
  assert.equal(await inStore(world, firstPacks[0] ?? ""), true);
  assert.equal(await inStore(world, firstPacks.at(-1) ?? ""), false);
});

test("a pack another session lists stays in object storage across a reset after a snapshot commits and before its old packs are deleted, and a pack whose delete failed is uploaded again", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const shared = sha256("shared pack");
  const onlyFirst = sha256("first pack");
  const onlySecond = sha256("second pack");
  const onlyThird = sha256("third pack");
  const onlyOther = sha256("other pack");

  const s1 = await turnAsksSnapshot(world, host, null);
  await sendsParts(world, host, s1, [shared, onlyFirst], []);
  await host.says(done(s1));
  const other = await turnAsksSnapshot(world, host, null);
  await sendsParts(world, host, other, [onlyOther], [shared]);
  await host.says(done(other));

  const s2 = await turnAsksSnapshot(world, host, s1.sessionId);
  await sendsParts(world, host, s2, [onlySecond], [shared]);
  t.mock.method(
    world.store,
    "delete",
    async () => {
      throw new Error("the object storage delete was cut off by a reset");
    },
    { times: 1 },
  );
  await assert.rejects(host.says(done(s2)), /cut off by a reset/);
  await world.restartTenant();
  assert.deepEqual(refsOf(world, [shared, onlyFirst]), [2, 0], "the failed delete keeps the zero-ref row");
  assert.equal(await inStore(world, onlyFirst), true);

  const s3 = await turnAsksSnapshot(world, host, s1.sessionId);
  const uploads = await sendsParts(world, host, s3, [onlyThird, onlyFirst], []);
  assert.ok(uploads.includes(onlyFirst), "a hold of a zero-ref pack uploads it again");
  await host.says(done(s3));
  assert.equal(await inStore(world, shared), true, "the other session's snapshot still lists the shared pack");
  assert.deepEqual(refsOf(world, [shared, onlyFirst, onlySecond]), [1, 1]);
  assert.equal(await inStore(world, onlySecond), false);

  await seedsSnapshot(world, s1.sessionId, 4, [shared, onlyThird]);
  world
    .tenantSql()
    .exec(
      "UPDATE pack_refs SET refs = refs + 1 WHERE pack_digest IN (SELECT value FROM json_each(?))",
      JSON.stringify([shared, onlyThird]),
    );
  await world.call("archiveSession", { tenantId: TENANT_ID, sessionId: s1.sessionId, now: Date.now() });
  assert.equal(await inStore(world, shared), true, "archiving two live snapshots keeps a pack another session lists");
  assert.equal(await inStore(world, onlyThird), false);
  assert.equal(await inStore(world, onlyFirst), false);
  assert.deepEqual(refsOf(world, [shared, onlyThird, onlyFirst]), [1]);
});

test("an archive that a stored snapshot races fails and keeps every pack the stored snapshot lists in object storage", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const kept = sha256("kept pack");
  const dropped = sha256("dropped pack");
  const added = sha256("added pack");

  const s2 = await turnAsksSnapshot(world, host, null);
  await sendsParts(world, host, s2, [kept, dropped], []);
  await host.says(done(s2));
  const s2Listed: string[] = JSON.parse((await (await world.store.get(`${s2.storageKey}.packs`))?.text()) ?? "[]");
  const onlyS2 = s2Listed.filter((packDigest) => packDigest !== kept);
  const other = await turnAsksSnapshot(world, host, null);
  await sendsParts(world, host, other, [], onlyS2);
  await host.says(done(other));
  await world.sendTurn(s2.sessionId, "next");
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.writes(offer.turnId, 2, ['{"type":"result","subtype":"error_during_execution","is_error":false}']);
  await host.says({
    type: "TurnComplete",
    turnId: offer.turnId,
    lastLineSeq: 2,
    completedAt: new Date(Date.now()).toISOString(),
  });
  const s3 = snapshotAsked(host, s2.sessionId);
  await sendsParts(world, host, s3, [added], [kept]);
  const get = world.store.get.bind(world.store);
  let raced = false;
  t.mock.method(world.store, "get", async (key: string) => {
    const object = await get(key);
    if (!raced && key === `${s2.storageKey}.packs`) {
      raced = true;
      await host.says(done(s3));
    }
    return object;
  });

  await assert.rejects(
    world.call("archiveSession", { tenantId: TENANT_ID, sessionId: s2.sessionId, now: Date.now() }),
    new RegExp(`stored snapshot ${s3.snapshotId} while it was being archived`),
  );
  assert.equal(await inStore(world, kept), true, "the stored snapshot still lists the kept pack");
  const listed: string[] = JSON.parse((await (await get(`${s3.storageKey}.packs`))?.text()) ?? "[]");
  assert.ok(listed.includes(kept));
  for (const packDigest of listed) assert.equal(await inStore(world, packDigest), true, `${packDigest} stays`);
  assert.deepEqual(refsOf(world, [...listed, ...onlyS2]), Array(listed.length + onlyS2.length).fill(1));

  await world.call("archiveSession", { tenantId: TENANT_ID, sessionId: s2.sessionId, now: Date.now() });
  assert.deepEqual(refsOf(world, [...listed, ...onlyS2]), Array(onlyS2.length).fill(1));
  for (const packDigest of listed) assert.equal(await inStore(world, packDigest), false);
  for (const packDigest of onlyS2) assert.equal(await inStore(world, packDigest), true, "the other session lists it");
});

test("the import deletes the old pack counts before it deletes a pack no snapshot lists", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const p1 = sha256("imported pack 1");
  const dead = `${TENANT_ID}/imported/snapshots/00000000-dead`;
  await world.store.put(`${dead}.packs`, JSON.stringify([p1]));
  await world.store.put(`${TENANT_ID}/packs/${p1}`, "pack");
  await world.store.put(
    `${TENANT_ID}/live-packs.json`,
    JSON.stringify({ members: [dead], counts: [[p1, 1]], held: [] }),
  );
  world.tenantSql().exec("DELETE FROM pack_refs_imported");
  world.store.failure = { operation: "delete", prefix: `${TENANT_ID}/packs/`, error: new Error("delete refused") };
  await assert.rejects(world.restartTenant(), /delete refused/);
  world.store.failure = null;

  assert.equal(await world.store.get(`${TENANT_ID}/live-packs.json`), null);
  assert.deepEqual(refsOf(world, [p1]), [0]);
  assert.notEqual(await world.store.get(`${TENANT_ID}/packs/${p1}`), null);
});

test("the import of the tenant's pack counts drops dead members, adds live snapshots it misses, and runs once", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const p1 = sha256("imported pack 1");
  const p2 = sha256("imported pack 2");
  const p3 = sha256("imported pack 3");
  const p4 = sha256("imported pack 4");
  const p5 = sha256("imported pack 5");
  const counted = await seedsSnapshot(world, "imported", 1, [p1, p2]);
  await seedsSnapshot(world, "imported", 2, [p2, p3]);
  const dead = `${TENANT_ID}/imported/snapshots/00000000-dead`;
  const unlisted = `${TENANT_ID}/imported/snapshots/00000000-unlisted`;
  await world.store.put(`${dead}.packs`, JSON.stringify([p1, p4]));
  await world.store.put(`${TENANT_ID}/packs/${p4}`, "pack");
  const saved = JSON.stringify({
    members: [counted, dead, unlisted],
    counts: [
      [p1, 2],
      [p2, 1],
      [p4, 1],
      [p5, 1],
    ],
    held: [["held-session", [[p5, false]]]],
  });
  await world.store.put(`${TENANT_ID}/live-packs.json`, saved);
  world.tenantSql().exec("DELETE FROM pack_refs_imported");
  await world.restartTenant();

  assert.deepEqual(refsOf(world, [p1, p2, p3, p4, p5]), [1, 2, 1, 1]);
  assert.equal(await world.store.get(`${TENANT_ID}/packs/${p4}`), null, "a pack only the dead member named is deleted");
  assert.deepEqual(
    world
      .tenantSql()
      .exec("SELECT session_id, pack_digest, uploaded FROM pack_holds")
      .toArray()
      .map((row) => ({ ...row })),
    [{ session_id: "held-session", pack_digest: p5, uploaded: 0 }],
  );
  assert.equal(await world.store.get(`${TENANT_ID}/live-packs.json`), null);

  await world.store.put(`${TENANT_ID}/live-packs.json`, saved);
  await world.restartTenant();
  assert.deepEqual(refsOf(world, [p1, p2, p3, p4, p5]), [1, 2, 1, 1], "a reset after the commit imports nothing twice");
});
