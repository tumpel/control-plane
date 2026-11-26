import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { PrepareOfferResultSchema, StartedSessionSchema } from "@tumpel/schemas";
import { z } from "zod";
import { type Host, type Member, TENANT_ID, World } from "./harness/world.ts";
import { mcpPersona } from "./signal-fixtures.ts";

const McpReplySchema = z.object({
  result: z.object({ content: z.array(z.object({ text: z.string() })), isError: z.optional(z.boolean()) }),
});

export const claimedForeman = async (world: World, host: Host, personaId: string) => {
  const started = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({
      personaId,
      repository: "https://github.com/acme/app",
      model: "opus",
      prompt: "plan the work",
      boxRetention: "Warm",
    }),
  );
  assert.equal(started.status, 200, await started.clone().text());
  const { session } = StartedSessionSchema.parse(await started.json());
  const offer = host.takeOffer();
  assert.equal(offer.sessionId, session.sessionId);
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
  const token: Member = { ...world.owner, token: accessToken };
  return { session, offer, token };
};

let mcpId = 0;
export const tool = async (
  world: World,
  member: Member,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; text: string }> => {
  mcpId += 1;
  const response = await world.fetch(
    member,
    "POST",
    "/mcp",
    JSON.stringify({ jsonrpc: "2.0", id: mcpId, method: "tools/call", params: { name, arguments: args } }),
  );
  assert.equal(response.status, 200);
  const { result } = McpReplySchema.parse(await response.json());
  return { ok: result.isError !== true, text: result.content[0]?.text ?? "" };
};

export const statusTrigger = (name: string, personaId: string, sessionId?: string) => ({
  name,
  source: {
    kind: "GitHub",
    event: "status",
    conditions: [
      { field: "repository.full_name", values: ["acme/app"] },
      { field: "context", values: ["agent-review"] },
      { field: "state", values: ["success", "failure"] },
    ],
  },
  personaId,
  model: "opus",
  prompt: "agent-review on {{sha}} reads {{state}}",
  ...(sessionId === undefined ? {} : { sessionId }),
});

export const foremanIdle = async (t: TestContext) => {
  const world = await World.open();
  t.after(() => world.close());
  const host = await world.hostOnline("host-1");
  const personaId = await mcpPersona(world);
  const { token, ...foreman } = await claimedForeman(world, host, personaId);
  const rows = () => ({ tenant: world.tenantRowsWritten(), central: world.db.sql.rowsWritten });
  const written = (before: { tenant: number; central: number }) => {
    const after = rows();
    return { tenant: after.tenant - before.tenant, central: after.central - before.central };
  };
  const ownerCreate = async (name: string, sessionId?: string): Promise<Response> =>
    world.fetch(world.owner, "POST", "/v1/triggers", JSON.stringify(statusTrigger(name, personaId, sessionId)));
  return { world, host, personaId, foreman, token, rows, written, ownerCreate };
};
