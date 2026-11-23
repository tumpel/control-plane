import assert from "node:assert/strict";
import { test } from "node:test";
import { PersonaMetadataListSchema, PersonaSchema } from "@tumpel/schemas";
import { z } from "zod";
import { World } from "./harness/world.ts";

test("MCP lists persona file metadata without content or writes and reads the original bytes on demand", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const defaultsResponse = await world.fetch(world.owner, "GET", "/v1/personas");
  assert.equal(defaultsResponse.status, 200);
  const defaults = PersonaSchema.array().parse(await defaultsResponse.json());
  const [initial] = defaults;
  assert.ok(initial);
  const personas = [];
  for (const { name, text } of [
    { name: "reviewer", text: "Review each change carefully.\n" },
    { name: "writer", text: "Write plain sentences.\n" },
    { name: "builder", text: "Build café tools.\n\u0000" },
  ]) {
    const response = await world.fetch(
      world.owner,
      "POST",
      "/v1/personas",
      JSON.stringify({
        name,
        harness: "ClaudeCode",
        secretSetId: initial.secretSetId,
        connectorIds: [],
        files: [{ source: "Inline", path: ".claude/CLAUDE.md", content: Buffer.from(text).toString("base64") }],
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    personas.push(PersonaSchema.parse(await response.json()));
  }
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
  const { result } = reply.parse(await response.json());
  const text = result.content[0]?.text;
  assert.ok(text);
  assert.equal(text.includes('"content"'), false);
  assert.equal(text.includes('"downloadUrl"'), false);
  const listed = PersonaMetadataListSchema.parse(JSON.parse(text));
  const expected = [...defaults, ...personas].map(({ files, ...persona }) => ({
    ...persona,
    files: files.map(({ path, digest, sizeBytes, createdAt, updatedAt }) => ({
      path,
      digest,
      sizeBytes,
      createdAt,
      updatedAt,
    })),
  }));
  assert.deepEqual(
    listed,
    expected.toSorted((a, b) => a.personaId.localeCompare(b.personaId)),
  );
  const full = await world.fetch(world.owner, "GET", "/v1/personas");
  assert.equal(full.status, 200);
  assert.deepEqual(
    PersonaSchema.array().parse(await full.json()),
    [...defaults, ...personas].toSorted((a, b) => a.personaId.localeCompare(b.personaId)),
  );
  const read = await world.fetch(
    world.owner,
    "POST",
    "/mcp",
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tumpel_persona_get", arguments: { personaId: personas[2]?.personaId } },
    }),
  );
  assert.equal(read.status, 200);
  const file = PersonaSchema.parse(JSON.parse(reply.parse(await read.json()).result.content[0]?.text ?? "")).files[0];
  assert.ok(file?.source === "Inline");
  assert.deepEqual(Buffer.from(file.content, "base64"), Buffer.from("Build café tools.\n\u0000"));
});
