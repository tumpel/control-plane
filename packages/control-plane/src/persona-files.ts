import { type PersonaCreateSchema, PersonaFileLimit } from "@tumpel/api/schemas";
import type { z } from "zod";
import { decodeBase64 } from "./channel/protocol.ts";
import type { HarnessCatalogEntry } from "./harness-catalog.ts";
import type { Problem } from "./http.ts";

export type PersonaFileWrite = z.infer<typeof PersonaCreateSchema>["files"][number];

export interface StoredFile {
  path: string;
  digest: string;
  sizeBytes: number;
}

export interface CheckedFile extends StoredFile {
  bytes: Uint8Array<ArrayBuffer> | null;
}

export interface BlobStore {
  put(key: string, bytes: Uint8Array<ArrayBuffer>): Promise<unknown>;
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export type Checked = { ok: true; files: CheckedFile[] } | { ok: false; problem: Problem };

export const UPLOAD_TTL_SECONDS = 900;

export const UPLOAD_FIX =
  "Upload a file larger than PersonaFileLimit.InlineFileBytes with POST /v1/personas/file-uploads (tumpel persona upload-file), then name it as a Stored file by digest; tumpel config apply does this for you";

export const personaFileKey = (tenantId: string, digest: string): string => `${tenantId}/persona-files/${digest}`;

export const sha256Hex = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const refused = (title: string, detail: string, fix: string): Checked => ({
  ok: false,
  problem: { code: "InvalidRequest", title, detail, fix },
});

const decoded = async (write: PersonaFileWrite): Promise<CheckedFile | null> => {
  if (write.source === "Stored") {
    return { path: write.path, digest: write.digest, sizeBytes: write.sizeBytes, bytes: null };
  }
  const bytes = decodeBase64(write.content);
  if (bytes === null) return null;
  return { path: write.path, digest: await sha256Hex(bytes), sizeBytes: bytes.byteLength, bytes };
};

export const checkFiles = async (
  entry: HarnessCatalogEntry,
  writes: readonly PersonaFileWrite[],
  operation: string,
): Promise<Checked> => {
  const seen = new Set<string>();
  const accepted = entry.personaFilePaths;
  for (const write of writes) {
    if (seen.has(write.path)) {
      return refused(
        "Repeated persona file",
        `${operation} lists the path ${write.path} more than once`,
        "List each path of a persona once",
      );
    }
    seen.add(write.path);
    if (!accepted.includes(write.path)) {
      return refused(
        "Path not read by the harness",
        accepted.length === 0
          ? `${operation} gives ${entry.harness} a file at ${write.path}, and ${entry.harness} ${entry.harnessVersion} reads no persona files`
          : `${operation} gives ${entry.harness} a file at ${write.path}, which ${entry.harness} ${entry.harnessVersion} does not read; it accepts ${accepted.join(", ")}`,
        "Put the file at one of the accepted paths, relative to the harness home, or leave it out",
      );
    }
  }
  const files: CheckedFile[] = [];
  for (const write of writes) {
    const file = await decoded(write);
    if (file === null) {
      return refused(
        "Persona file is not base64",
        `${operation} sends ${write.path} with content that is not base64`,
        "Send the file's bytes base64-encoded in content",
      );
    }
    if (file.bytes !== null && file.sizeBytes > PersonaFileLimit.InlineFileBytes) {
      return refused(
        "Persona file too large to send inline",
        `${operation} sends ${file.path} inline with ${file.sizeBytes} bytes, over the ${PersonaFileLimit.InlineFileBytes}-byte inline cap`,
        UPLOAD_FIX,
      );
    }
    files.push(file);
  }
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (total > PersonaFileLimit.PersonaBytes) {
    return refused(
      "Persona files too large",
      `${operation} gives the persona ${total} bytes of files, over the ${PersonaFileLimit.PersonaBytes}-byte cap on a persona`,
      "Trim the files or split them across personas",
    );
  }
  return { ok: true, files };
};

export const storeFiles = async (
  store: BlobStore,
  tenantId: string,
  files: readonly CheckedFile[],
  operation: string,
): Promise<{ ok: true; files: StoredFile[] } | { ok: false; problem: Problem }> => {
  for (const file of files) {
    const key = personaFileKey(tenantId, file.digest);
    if (file.bytes !== null) {
      await store.put(key, file.bytes);
      continue;
    }
    const held = await store.get(key);
    if (held === null) {
      return {
        ok: false,
        problem: {
          code: "NotFound",
          title: "Persona file not uploaded",
          detail: `${operation} names ${file.path} by digest ${file.digest}, which the store does not hold`,
          fix: UPLOAD_FIX,
        },
      };
    }
    if (held.size !== file.sizeBytes) {
      return {
        ok: false,
        problem: {
          code: "InvalidRequest",
          title: "Persona file size differs",
          detail: `${operation} names ${file.path} with ${file.sizeBytes} bytes, and the store holds ${held.size} bytes under digest ${file.digest}`,
          fix: "Upload the file again to a fresh presigned URL and name it with its own digest and size",
        },
      };
    }
    const digest = await sha256Hex(new Uint8Array(await held.arrayBuffer()));
    if (digest !== file.digest) {
      return {
        ok: false,
        problem: {
          code: "InvalidRequest",
          title: "Persona file digest differs",
          detail: `${operation} names ${file.path} by digest ${file.digest}, and the bytes the store holds under it hash to ${digest}`,
          fix: "Upload the file's own bytes again to a fresh presigned URL for its digest, then repeat the write",
        },
      };
    }
  }
  return { ok: true, files: files.map(({ path, digest, sizeBytes }) => ({ path, digest, sizeBytes })) };
};
