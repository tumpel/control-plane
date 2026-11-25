import assert from "node:assert/strict";
import { test } from "node:test";
import { PersonaSchema, PrepareOfferResultSchema, ProblemSchema, StartRefusedEventSchema } from "@tumpel/schemas";
import { z } from "zod";
import { GITHUB_TOKEN_PREFIX } from "./harness/github.ts";
import { TENANT_ID, World } from "./harness/world.ts";

test("person preflight records catalog and model refusals from the two start routes", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const personas = await world.fetch(world.owner, "GET", "/v1/personas");
  assert.equal(personas.status, 200);
  const [persona] = PersonaSchema.array().parse(await personas.json());
  assert.ok(persona);
  const sql = world.tenantStorage(TENANT_ID).sql;
  const count = (): number => Number(sql.exec("SELECT COUNT(*) AS count FROM events").one().count);

  await world.call("pin", { pin: { harness: "ClaudeCode", harnessVersion: "2.1.1" }, now: Date.now() });
  const beforeCatalog = count();
  const catalogMeter = world.tenantRowsWritten();
  const catalog = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: persona.personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "start work",
      tags: ["crew:x"],
    }),
  );
  assert.equal(catalog.status, 422);
  const catalogProblem = ProblemSchema.parse(await catalog.json());
  assert.equal(catalogProblem.code, "HarnessNotInCatalog");
  assert.equal(count() - beforeCatalog, 1);
  assert.equal(world.tenantRowsWritten() - catalogMeter, 2);

  await world.call("unpin", { harness: "ClaudeCode" });
  await world.call("setSecretMember", {
    tenantId: TENANT_ID,
    secretSetId: persona.secretSetId,
    member: { kind: "Variable", name: "GITHUB_TOKEN", value: `${GITHUB_TOKEN_PREFIX}refusal` },
    githubUser: { githubUserId: 1, login: "scenario" },
    now: Date.now(),
  });
  const beforeModel = count();
  const modelMeter = world.tenantRowsWritten();
  const model = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions/from-issue",
    JSON.stringify({
      personaId: persona.personaId,
      owner: "acme",
      name: "app",
      issueNumber: 12,
      model: "unsupported-model",
      tags: ["crew:y"],
    }),
  );
  assert.equal(model.status, 422);
  const modelProblem = ProblemSchema.parse(await model.json());
  assert.equal(modelProblem.code, "ModelUnsupported");
  assert.equal(count() - beforeModel, 1);
  assert.equal(world.tenantRowsWritten() - modelMeter, 2);

  const listed = await world.fetch(world.owner, "GET", "/v1/events?afterEventId=0&event=StartRefused");
  assert.equal(listed.status, 200);
  const { events } = z.object({ events: StartRefusedEventSchema.array() }).parse(await listed.json());
  assert.deepEqual(
    events.map(({ operation, refusal, caller, crewTags }) => ({ operation, refusal, caller: caller.kind, crewTags })),
    [
      {
        operation: "Start",
        refusal: { code: catalogProblem.code, detail: catalogProblem.detail },
        caller: "Person",
        crewTags: ["crew:x"],
      },
      {
        operation: "Start",
        refusal: { code: modelProblem.code, detail: modelProblem.detail },
        caller: "Person",
        crewTags: ["crew:y"],
      },
    ],
  );
});

test("Foreman preflight keeps its model refusal when more than 16 tags would be inherited", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  await world.holdsAgentCredentials();
  const host = await world.hostOnline("host-1");
  const foreman = await world.startSession({ prompt: "plan the work", tags: [] });
  const enabled = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${foreman.personaId}`,
    JSON.stringify({ tumpelMcp: true }),
  );
  assert.equal(enabled.status, 200);
  await world.subscribe(foreman, {
    prompt: "Continue the work",
    goal: "Land the work",
    events: ["StartRefused", "CapacityAvailable", "TurnCompleted"],
    crewTags: ["crew:x"],
  });
  const running = host.takeOffer();
  await host.claims(running);
  const ready = await world.sendTurn(foreman.sessionId, "accept a Tumpel turn token");
  await host.finishes(running);
  const offer = host.takeOffer();
  assert.equal(offer.turnId, ready.turnId);
  const { prepared } = PrepareOfferResultSchema.parse(
    await world.call("prepareOffer", {
      tenantId: TENANT_ID,
      turnId: offer.turnId,
      hostId: host.hostId,
      now: Date.now(),
    }),
  );
  assert.equal(prepared.kind, "Ready");
  await host.claims(offer);
  const connector = prepared.credential.connectors.find(({ connectorId }) => connectorId === "tumpel");
  assert.ok(connector);
  const token = await world.request(new URL(connector.tokenUrl).pathname, {
    method: "POST",
    headers: { authorization: `Bearer ${connector.tokenCredential}` },
  });
  assert.equal(token.status, 200);
  const { accessToken } = z.object({ accessToken: z.string() }).parse(await token.json());
  const sql = world.tenantStorage(TENANT_ID).sql;
  const count = (): number => Number(sql.exec("SELECT COUNT(*) AS count FROM events").one().count);
  const rows = count();
  const before = world.tenantRowsWritten();
  const refused = await world.fetch(
    { ...world.owner, token: accessToken },
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId: foreman.personaId,
      repository: foreman.repository,
      model: "unsupported-model",
      prompt: "start work",
      tags: Array.from({ length: 16 }, (_, index) => `own:${index}`),
    }),
  );
  assert.equal(refused.status, 422);
  const problem = ProblemSchema.parse(await refused.json());
  assert.equal(problem.code, "ModelUnsupported");
  assert.equal(count() - rows, 0);
  assert.equal(world.tenantRowsWritten() - before, 0);
});
