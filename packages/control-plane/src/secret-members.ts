import { SecretSetCreateSchema, SecretSetSchema } from "@tumpel/api/schemas";
import type { SecretKey, SecretMember } from "./dispatch-variables.ts";
import { issues, type Problem } from "./http.ts";

export type MemberRow = {
  name: string;
  kind: string;
  sealed: string;
  updated_at: number;
  provider: string | null;
  expires_at: string | null;
};

export type UnreadableMember = { kind: "Unreadable"; name: string; detail: string };

export type StoredKeys = { kind: "Keys"; keys: SecretKey[] } | UnreadableMember;

export type UnreadableSecretSet = {
  kind: "Unreadable";
  secretSetId: string;
  name: string;
  member: string;
  detail: string;
};

export const unreadableSecretSet = (operation: string, unreadable: UnreadableSecretSet): Problem => ({
  code: "Conflict",
  title: "Stored secret member unreadable",
  detail: `${operation} read member ${unreadable.member} of secret set ${unreadable.name} (${unreadable.secretSetId}), which no longer matches its kind: ${unreadable.detail}`,
  fix: `Write member ${unreadable.member} again with tumpel secret-set set-member, or rewrite secret set ${unreadable.name} with tumpel secret-set update`,
});

const memberShape = (row: MemberRow): Record<string, unknown> =>
  row.kind === "Variable"
    ? { kind: row.kind, name: row.name }
    : row.kind === "ApiKey"
      ? { kind: row.kind, name: row.name, provider: row.provider }
      : { kind: row.kind, name: row.name, provider: row.provider, expiresAt: row.expires_at };

export const storedKeys = (rows: readonly MemberRow[]): StoredKeys => {
  const keys: SecretKey[] = [];
  for (const row of rows) {
    const parsed = SecretSetSchema.shape.keys.element.safeParse({ ...memberShape(row), updatedAt: row.updated_at });
    if (!parsed.success) return { kind: "Unreadable", name: row.name, detail: issues(parsed.error) };
    keys.push(parsed.data);
  }
  return { kind: "Keys", keys };
};

export const toMember = (row: MemberRow, value: string): SecretMember =>
  SecretSetCreateSchema.shape.secrets.element.parse({ ...memberShape(row), value });
