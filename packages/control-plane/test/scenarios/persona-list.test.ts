import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PersonaSchema, SecretSetSchema, StoredPersonaSchema } from "@tumpel/schemas";
import { z } from "zod";
import { World } from "./harness/world.ts";

const ToolReplySchema = z.object({
  result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ text: z.string() })) }),
});

test("MCP lists 22 personas with file metadata and reads their bytes on demand", async (t) => {
  const world = await World.open();
  t.after(() => world.close());
  const token = Buffer.alloc(32, 3).toString("base64url");
  world.db.sql.exec(
    "INSERT INTO memberships (tenant_id, principal_id, role, created_at) VALUES (?, ?, 'Owner', ?)",
    "tenant-scenario",
    "principal-scenario",
    Date.now(),
  );
  world.db.sql.exec(
    "INSERT INTO devices (device_id, token_sha256, tenant_id, principal_id, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    "device-scenario",
    createHash("sha256").update(token).digest("hex"),
    "tenant-scenario",
    "principal-scenario",
    "scenario",
    Date.now(),
    Date.now(),
  );
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const defaults = await world.fetch("/v1/personas", { headers });
  assert.equal(defaults.status, 200);
  for (const persona of StoredPersonaSchema.array().parse(await defaults.json())) {
    const removed = await world.fetch(`/v1/personas/${persona.personaId}`, { method: "DELETE", headers });
    assert.equal(removed.status, 204);
  }
  const secretSetResponse = await world.fetch("/v1/secret-sets", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "scenario",
      secrets: [{ kind: "ApiKey", name: "ANTHROPIC_API_KEY", provider: "Anthropic", value: "sk-ant-scenario-test" }],
    }),
  });
  assert.equal(secretSetResponse.status, 200, await secretSetResponse.clone().text());
  const secretSet = SecretSetSchema.parse(await secretSetResponse.json());
  const bytes = Buffer.from("Review each change carefully.\n".repeat(145));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const personas = [];
  for (let index = 0; index < 22; index += 1) {
    const response = await world.fetch("/v1/personas", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: `reviewer-${index}`,
        harness: "ClaudeCode",
        secretSetId: secretSet.secretSetId,
        connectorIds: [],
        files: [{ source: "Inline", path: ".claude/CLAUDE.md", content: bytes.toString("base64") }],
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    personas.push(PersonaSchema.parse(await response.json()));
  }
  assert.ok(JSON.stringify(personas).length >= 123_000);
  const listResponse = await world.fetch("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tumpel_persona_list" } }),
  });
  assert.equal(listResponse.status, 200);
  const { result } = ToolReplySchema.parse(await listResponse.json());
  assert.ok(!result.isError);
  const text = result.content[0]?.text ?? "";
  const listed = z
    .array(z.looseObject({ personaId: z.string(), name: z.string(), files: z.array(z.looseObject({})) }))
    .parse(JSON.parse(text));
  assert.equal(listed.length, 22);
  for (const persona of personas) {
    const summary = listed.find((entry) => entry.personaId === persona.personaId);
    assert.ok(summary, persona.name);
    assert.deepEqual(summary, {
      ...persona,
      files: persona.files.map(({ path, digest, sizeBytes, createdAt, updatedAt }) => ({
        path,
        digest,
        sizeBytes,
        createdAt,
        updatedAt,
      })),
    });
    assert.equal(summary.files.length, 1);
    assert.equal(summary.files[0]?.digest, digest);
    assert.equal(summary.files[0]?.sizeBytes, bytes.length);
  }
  assert.equal(text.includes('"content"'), false);
  assert.ok(text.length < 22_000);
  const personaId = personas[0]?.personaId;
  const readResponse = await world.fetch("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tumpel_persona_get", arguments: { personaId } },
    }),
  });
  assert.equal(readResponse.status, 200);
  const read = ToolReplySchema.parse(await readResponse.json());
  assert.ok(!read.result.isError);
  const persona = PersonaSchema.parse(JSON.parse(read.result.content[0]?.text ?? ""));
  const [file] = persona.files;
  assert.ok(file?.source === "Inline");
  assert.deepEqual(Buffer.from(file.content, "base64"), bytes);
  const getResponse = await world.fetch(`/v1/personas/${personaId}`, { headers });
  assert.equal(getResponse.status, 200);
  assert.deepEqual(PersonaSchema.parse(await getResponse.json()), persona);
});
