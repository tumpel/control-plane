import assert from "node:assert/strict";
import { test } from "node:test";
import { PersonaMetadataListSchema } from "@tumpel/schemas";
import { z } from "zod";
import { World } from "./harness/world.ts";

test("MCP lists file metadata without content or SQL writes", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const defaults = await world.fetch(world.owner, "GET", "/v2/personas");
  assert.equal(defaults.status, 200);
  const [persona] = PersonaMetadataListSchema.parse(await defaults.json());
  assert.ok(persona);
  const patched = await world.fetch(
    world.owner,
    "POST",
    `/v1/personas/${persona.personaId}/file-patches`,
    JSON.stringify({
      kind: "Put",
      file: {
        source: "Inline",
        path: ".claude/CLAUDE.md",
        content: Buffer.from("Review carefully.\n").toString("base64"),
      },
    }),
  );
  assert.equal(patched.status, 200);
  const rowsBefore = world.rowsWritten(world.owner);
  const centralRowsBefore = world.db.sql.rowsWritten;
  const response = await world.fetch(
    world.owner,
    "POST",
    "/mcp",
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tumpel_persona_list" } }),
  );
  assert.equal(response.status, 200);
  assert.equal(world.rowsWritten(world.owner) - rowsBefore, 0);
  assert.equal(world.db.sql.rowsWritten - centralRowsBefore, 0);
  const reply = z.object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) });
  const text = reply.parse(await response.json()).result.content[0]?.text;
  assert.ok(text);
  assert.equal(text.includes('"content"'), false);
  assert.equal(text.includes('"downloadUrl"'), false);
  const [listed] = PersonaMetadataListSchema.parse(JSON.parse(text));
  assert.equal(listed?.personaId, persona.personaId);
  assert.equal(listed?.files[0]?.path, ".claude/CLAUDE.md");
});
