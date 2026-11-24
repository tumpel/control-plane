import assert from "node:assert/strict";
import { type BoxRetentionSchema, PersonaSchema, StartedSessionSchema } from "@tumpel/schemas";
import type { z } from "zod";
import type { Host, TurnOffer, World } from "./harness/world.ts";

export const mcpPersona = async (world: World): Promise<string> => {
  const listed = await world.fetch(world.owner, "GET", "/v1/personas");
  assert.equal(listed.status, 200);
  const [persona] = PersonaSchema.array().parse(await listed.json());
  assert.ok(persona);
  const enabled = await world.fetch(
    world.owner,
    "PATCH",
    `/v1/personas/${persona.personaId}`,
    JSON.stringify({ tumpelMcp: true }),
  );
  assert.equal(enabled.status, 200);
  return persona.personaId;
};

export const startBox = async (
  world: World,
  host: Host,
  personaId: string,
  prompt: string,
  boxRetention: z.infer<typeof BoxRetentionSchema>,
  tags: string[] = [],
): Promise<{ session: z.infer<typeof StartedSessionSchema>["session"]; offer: TurnOffer }> => {
  const started = await world.fetch(
    world.owner,
    "POST",
    "/v1/sessions",
    JSON.stringify({ personaId, repository: "https://github.com/acme/app", model: "opus", prompt, boxRetention, tags }),
  );
  assert.equal(started.status, 200, await started.clone().text());
  const { session } = StartedSessionSchema.parse(await started.json());
  const offer = host.takeOffer();
  assert.equal(offer.sessionId, session.sessionId);
  await host.claims(offer);
  return { session, offer };
};
