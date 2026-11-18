#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrebuildTemplateManifestSchema } from "@tumpel/schemas";
import { GUEST_TOOLCHAINS } from "../packages/control-plane/src/guest-toolchains.ts";
import { RecordedVersionsSchema, recordProblems } from "../packages/control-plane/src/template-catalog.ts";

const TEMPLATES = fileURLToPath(new URL("../packages/control-plane/templates", import.meta.url));

const directories = (path) =>
  readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

const onDisk = directories(TEMPLATES).flatMap((prebuildTemplateId) =>
  directories(join(TEMPLATES, prebuildTemplateId)).map((version) => {
    const dir = join(TEMPLATES, prebuildTemplateId, version);
    const manifest = PrebuildTemplateManifestSchema.parse(JSON.parse(readFileSync(join(dir, "template.json"), "utf8")));
    return {
      prebuildTemplateId,
      prebuildTemplateVersion: Number(version),
      digest: createHash("sha256")
        .update(readFileSync(join(dir, "devcontainer.jsonc")))
        .digest("hex"),
      toolchains: manifest.toolchains,
    };
  }),
);

const recorded = RecordedVersionsSchema.parse(JSON.parse(readFileSync(join(TEMPLATES, "versions.json"), "utf8")));
const problems = recordProblems(recorded, onDisk, GUEST_TOOLCHAINS);
if (problems.length > 0) {
  console.error(`templates check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`templates: ${recorded.length} recorded versions match their files and the guest image`);
