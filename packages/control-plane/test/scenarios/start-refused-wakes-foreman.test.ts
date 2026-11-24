import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CapacityAvailableEventSchema,
  PersonaSchema,
  PrepareOfferResultSchema,
  ProblemSchema,
  StartedSessionSchema,
  StartRefusedEventSchema,
  TenantEventSchema,
} from "@tumpel/schemas";
import { z } from "zod";
import { RELEASE_CACHE_MS } from "../../src/releases.ts";
import { GITHUB_TOKEN_PREFIX, installApp } from "./harness/github.ts";
import { DEFAULT_USAGE } from "./harness/supervisor.ts";
import { type Host, type Member, SETTINGS, TENANT_ID, type TurnOffer, World } from "./harness/world.ts";
import { mcpPersona, startBox } from "./signal-fixtures.ts";

const claimForeman = async (
  world: World,
  host: Host,
  sessionId: string,
): Promise<{ offer: TurnOffer; member: Member }> => {
  const offer = host.takeOffer();
  assert.equal(offer.sessionId, sessionId);
  const { prepared } = PrepareOfferResultSchema.parse(
    await world.call("prepareOffer", {
      tenantId: TENANT_ID,
      turnId: offer.turnId,
      hostId: host.hostId,
      now: Date.now(),
    }),
  );
  assert.equal(prepared.kind, "Ready");
  const connector = prepared.credential.connectors.find(({ connectorId }) => connectorId === "tumpel");
  assert.ok(connector);
  await host.claims(offer);
  const response = await world.request(new URL(connector.tokenUrl).pathname, {
    method: "POST",
    headers: { authorization: `Bearer ${connector.tokenCredential}` },
  });
  assert.equal(response.status, 200);
  const { accessToken } = z.object({ accessToken: z.string() }).parse(await response.json());
  return { offer, member: { ...world.owner, token: accessToken } };
};

test("F1 records session placement refusals and excludes a refused prebuild and tag overflow", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const personaId = await mcpPersona(world);
  const start = {
    personaId,
    repository: "https://github.com/acme/app",
    model: "opus",
    prompt: "start crew work",
    boxRetention: "Warm",
  };
  const started = await world.fetch(world.owner, "POST", "/v1/sessions", JSON.stringify(start));
  assert.equal(started.status, 200);
  const { session: foreman } = StartedSessionSchema.parse(await started.json());
  await world.subscribe(foreman, {
    prompt: "Continue the work",
    goal: "Land the work",
    events: ["StartRefused", "CapacityAvailable", "TurnCompleted"],
    crewTags: ["crew:x"],
  });
  const { offer, member } = await claimForeman(world, host, foreman.sessionId);
  host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib });
  await world.settle();

  const listRefusals = async () => {
    const response = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=StartRefused");
    assert.equal(response.status, 200);
    return z.object({ events: StartRefusedEventSchema.array() }).parse(await response.json()).events;
  };
  const beforeStart = world.tenantRowsWritten();
  const refused = await world.fetch(
    member,
    "POST",
    "/v1/sessions",
    JSON.stringify({ ...start, tags: ["crew:y", "crew:x"] }),
  );
  assert.equal(refused.status, 409, await refused.clone().text());
  const pool = ProblemSchema.parse(await refused.json());
  assert.equal(pool.code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - beforeStart, 11);
  const first = await listRefusals();
  assert.equal(first.length, 1);

  await installApp(world.db, TENANT_ID, "prebuilt");
  const beforePrebuild = world.tenantRowsWritten();
  const prebuild = await world.fetch(
    world.owner,
    "POST",
    "/v1/prebuilds",
    JSON.stringify({
      personaId,
      repository: "https://github.com/prebuilt/app",
      provider: "CircleCI",
    }),
  );
  assert.equal(prebuild.status, 409, await prebuild.clone().text());
  assert.equal(ProblemSchema.parse(await prebuild.json()).code, "PoolExhausted");
  assert.equal(world.tenantRowsWritten() - beforePrebuild, 0);
  assert.deepEqual(await listRefusals(), first);

  const personas = await world.fetch(world.owner, "GET", "/v1/personas");
  assert.equal(personas.status, 200);
  const persona = PersonaSchema.array()
    .parse(await personas.json())
    .find((each) => each.personaId === personaId);
  assert.ok(persona);
  await world.call("setSecretMember", {
    tenantId: TENANT_ID,
    secretSetId: persona.secretSetId,
    member: { kind: "Variable", name: "GITHUB_TOKEN", value: `${GITHUB_TOKEN_PREFIX}refusal` },
    githubUser: { githubUserId: 1, login: "scenario" },
    now: Date.now(),
  });
  await world.releases.put("current.json", "unreadable release");
  await world.passes(RELEASE_CACHE_MS + 1);
  const beforeUnreadable = world.tenantRowsWritten();
  const unreadable = await world.fetch(
    member,
    "POST",
    "/v1/sessions/from-issue",
    JSON.stringify({
      personaId,
      owner: "acme",
      name: "app",
      issueNumber: 12,
      model: "opus",
    }),
  );
  assert.equal(unreadable.status, 422, await unreadable.clone().text());
  const image = ProblemSchema.parse(await unreadable.json());
  assert.equal(image.code, "ImageNotReleased");
  assert.equal(world.tenantRowsWritten() - beforeUnreadable, 3);
  const recorded = await listRefusals();
  assert.deepEqual(
    recorded.map(({ operation, caller, crewTags, refusal }) => ({ operation, caller, crewTags, refusal })),
    [pool, image].map(({ code, detail }, index) => ({
      operation: "Start",
      caller: { kind: "Turn", sessionId: foreman.sessionId, turnId: offer.turnId },
      crewTags: index === 0 ? ["crew:x", "crew:y"] : ["crew:x"],
      refusal: { code, detail },
    })),
  );

  const beforeOverflow = world.tenantRowsWritten();
  const overflow = await world.fetch(
    member,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      ...start,
      tags: Array.from({ length: 16 }, (_, index) => `own:${index}`),
    }),
  );
  assert.equal(overflow.status, 422);
  assert.match(ProblemSchema.parse(await overflow.json()).detail, /would carry 17 tags/);
  assert.equal(world.tenantRowsWritten() - beforeOverflow, 0);
  assert.deepEqual(await listRefusals(), recorded);
});

for (const code of ["PoolExhausted", "HarnessNotInCatalog", "ModelUnsupported"] as const) {
  test(`F1 wakes after ${code}, resets on a successful retry and pauses on the eleventh new wake`, async (t) => {
    const world = await World.open({ vars: { TUMPEL_SETTINGS: { ...SETTINGS, turnTotalBudgetSeconds: 7_200 } } });
    t.after(() => world.close());
    const host = await world.hostOnline("host-1");
    const personaId = await mcpPersona(world);
    const fullBox = code === "PoolExhausted" ? await startBox(world, host, personaId, "occupy the host", "Warm") : null;
    if (fullBox !== null) await host.finishes(fullBox.offer);
    const start = {
      personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "plan the work",
      boxRetention: "Warm",
    };
    const started = await world.fetch(world.owner, "POST", "/v1/sessions", JSON.stringify(start));
    assert.equal(started.status, 200);
    const { session: foreman } = StartedSessionSchema.parse(await started.json());
    const subscription = await world.subscribe(foreman, {
      prompt: "Continue the work",
      goal: "Land the work",
      events: ["StartRefused", "CapacityAvailable", "TurnCompleted"],
      crewTags: ["crew:x"],
    });
    const foremanTurn = await claimForeman(world, host, foreman.sessionId);
    host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib });
    await world.settle();
    host.quiet();

    const sql = world.tenantSql();
    const count = (event: string): number =>
      Number(
        sql.exec("SELECT COUNT(*) AS count FROM events WHERE json_extract(payload, '$.event') = ?", event).one().count,
      );
    const deliveries = (): number =>
      Number(
        sql
          .exec(
            `SELECT COUNT(*) AS count FROM subscription_turns JOIN turns USING (turn_id)
            WHERE subscription_id = ? AND state = 'Offered'`,
            subscription.subscriptionId,
          )
          .one().count,
      );
    const counter = (): number =>
      Number(
        sql
          .exec(
            "SELECT starts_refused_in_a_row FROM subscriptions WHERE subscription_id = ?",
            subscription.subscriptionId,
          )
          .one().starts_refused_in_a_row,
      );
    const quiet = world.tenantRowsWritten();
    await world.tick(3_600_000);
    assert.equal(world.tenantRowsWritten() - quiet, 0);
    assert.equal(count("StartRefused"), 0);
    assert.equal(count("CapacityAvailable"), 0);
    assert.equal(deliveries(), 0);
    assert.equal(host.holds("TurnOffer"), false);
    await host.beats();
    assert.equal((await world.turn(foremanTurn.offer.turnId)).state, "Running");

    if (code === "HarnessNotInCatalog") {
      await world.call("pin", { pin: { harness: "ClaudeCode", harnessVersion: "2.1.1" }, now: Date.now() });
    }
    const refusedStart = JSON.stringify({
      ...start,
      prompt: "start crew work",
      model: code === "ModelUnsupported" ? "unsupported-model" : start.model,
    });
    const refuse = async (member: Member, writes: number): Promise<void> => {
      const before = world.tenantRowsWritten();
      const refused = await world.fetch(member, "POST", "/v1/sessions", refusedStart);
      assert.equal(refused.status, code === "PoolExhausted" ? 409 : 422, await refused.clone().text());
      assert.equal(ProblemSchema.parse(await refused.json()).code, code);
      assert.equal(world.tenantRowsWritten() - before, writes);
    };
    for (let attempt = 1; attempt <= 6; attempt++) {
      await refuse(foremanTurn.member, attempt === 1 ? 11 : 3);
      assert.equal(count("StartRefused"), attempt);
      assert.equal(deliveries(), 1);
    }
    assert.equal(host.holds("TurnOffer"), false);

    await host.finishes(foremanTurn.offer);
    let wake = await claimForeman(world, host, foreman.sessionId);
    const events = wake.offer.prompt.split("\n").filter((line) => line.startsWith("{"));
    assert.equal(events.length, 1);
    const [eventText] = events;
    assert.ok(eventText);
    const refusal = StartRefusedEventSchema.parse(JSON.parse(eventText));
    assert.equal(refusal.refusal.code, code);
    assert.deepEqual(refusal.caller, { kind: "Turn", sessionId: foreman.sessionId, turnId: foremanTurn.offer.turnId });
    assert.deepEqual(refusal.crewTags, ["crew:x"]);
    assert.equal(counter(), 1);

    if (fullBox !== null) {
      await host.finishes(wake.offer);
      assert.equal(host.holds("TurnOffer"), false);
      const beforeStop = world.tenantRowsWritten();
      await host.dropsIdleBox(fullBox.offer);
      assert.equal(world.tenantRowsWritten() - beforeStop, 30);
      assert.equal((await world.session(fullBox.session.sessionId)).state, "Stopped");
      assert.equal(count("CapacityAvailable"), 1);
      assert.equal(deliveries(), 1);
      wake = await claimForeman(world, host, foreman.sessionId);
      const capacity = wake.offer.prompt.split("\n").filter((line) => line.startsWith("{"));
      assert.equal(capacity.length, 1);
      const signal = CapacityAvailableEventSchema.parse(JSON.parse(capacity[0] ?? ""));
      assert.equal(signal.code, "PoolExhausted");
      assert.equal(signal.hostId, host.hostId);
      assert.equal(counter(), 2);
      assert.equal(host.holds("TurnOffer"), false);
    }

    if (code === "HarnessNotInCatalog") await world.call("unpin", { harness: "ClaudeCode" });
    host.report({ memoryHeldMib: 0 });
    await world.settle();
    const sessionStarts = count("SessionStarted");
    const retryBefore = world.tenantRowsWritten();
    const retry = await world.fetch(
      wake.member,
      "POST",
      "/v1/sessions",
      JSON.stringify({ ...start, prompt: "start crew work" }),
    );
    assert.equal(retry.status, 200, await retry.clone().text());
    const { session: crew } = StartedSessionSchema.parse(await retry.json());
    assert.equal(world.tenantRowsWritten() - retryBefore, 32);
    assert.equal(count("SessionStarted") - sessionStarts, 1);
    assert.equal(count("CapacityAvailable"), fullBox === null ? 0 : 1);
    assert.equal(counter(), 0);
    const listed = await world.fetch(
      world.owner,
      "GET",
      `/v1/events?afterEventId=0&event=SessionStarted&sessionId=${crew.sessionId}`,
    );
    assert.equal(listed.status, 200);
    const page = z.object({ events: TenantEventSchema.array() }).parse(await listed.json());
    assert.deepEqual(
      page.events.map((event) => event.event === "SessionStarted" && event.caller),
      [{ kind: "Turn", sessionId: foreman.sessionId, turnId: wake.offer.turnId }],
    );
    const crewOffer = host.takeOffer();
    assert.equal(crewOffer.sessionId, crew.sessionId);
    await host.claims(crewOffer);

    host.report({ memoryHeldMib: DEFAULT_USAGE.memoryBudgetMib });
    await world.settle();
    if (code === "HarnessNotInCatalog") {
      await world.call("pin", { pin: { harness: "ClaudeCode", harnessVersion: "2.1.1" }, now: Date.now() });
    }
    for (let claimed = 1; claimed <= 10; claimed++) {
      await refuse(wake.member, 11);
      assert.equal(deliveries(), 1);
      await host.finishes(wake.offer);
      wake = await claimForeman(world, host, foreman.sessionId);
      assert.match(wake.offer.prompt, new RegExp(`"code":"${code}"`));
      assert.equal(counter(), claimed);
    }
    assert.equal((await world.subscription(subscription.subscriptionId)).state, "Active");
    await refuse(wake.member, 11);
    await host.finishes(wake.offer);
    assert.equal(host.holds("TurnOffer"), false);
    assert.equal(counter(), 10);
    assert.equal(count("SubscriptionPaused"), 1);
    const paused = await world.subscription(subscription.subscriptionId);
    assert.equal(paused.state, "Paused");
    assert.deepEqual(paused.reason, { kind: "StartsRefused" });
  });
}
