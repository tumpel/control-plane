import type { SecretKey, SecretMember } from "@tumpel/api/credentials";
import {
  type ModelProviderSchema,
  type SecretMemberUpdateSchema,
  SecretSetCreateSchema,
  SecretSetSchema,
} from "@tumpel/schemas";
import type { z } from "zod";
import { REPOSITORY_TOKEN } from "./github.ts";
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
  fix: `Write member ${unreadable.member} again, or rewrite secret set ${unreadable.name}`,
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

export type MemberUpdate = z.infer<typeof SecretMemberUpdateSchema>;

export type PlannedMember =
  | { kind: "Written"; member: SecretMember }
  | { kind: "Kept"; update: MemberUpdate; from: MemberRow };

export type UpdatePlan =
  | { kind: "Planned"; members: PlannedMember[]; keepsGitHubUser: boolean }
  | { kind: "NoStoredValue"; name: string; source: string }
  | { kind: "UncheckedToken"; source: string };

export const memberWith = (update: MemberUpdate, value: string): SecretMember =>
  SecretSetCreateSchema.shape.secrets.element.parse({ ...update, value });

const isRepositoryToken = (member: { kind: string; name: string }): boolean =>
  member.kind === "Variable" && member.name === REPOSITORY_TOKEN;

export const planUpdate = (stored: readonly MemberRow[], updates: readonly MemberUpdate[]): UpdatePlan => {
  const members: PlannedMember[] = [];
  let keepsGitHubUser = false;
  for (const update of updates) {
    if (update.value !== undefined) {
      members.push({ kind: "Written", member: memberWith(update, update.value) });
      continue;
    }
    const source = update.previousName ?? update.name;
    const from = stored.find((row) => row.name === source);
    if (from === undefined) return { kind: "NoStoredValue", name: update.name, source };
    if (isRepositoryToken(update)) {
      if (!isRepositoryToken(from)) return { kind: "UncheckedToken", source };
      keepsGitHubUser = true;
    }
    members.push({ kind: "Kept", update, from });
  }
  return { kind: "Planned", members, keepsGitHubUser };
};

const KEY_PREFIXES: readonly { provider: z.infer<typeof ModelProviderSchema>; prefix: string }[] = [
  { provider: "Anthropic", prefix: "sk-ant-" },
  { provider: "OpenRouter", prefix: "sk-or-" },
  { provider: "OpenAi", prefix: "sk-" },
];

export const keyPrefixMismatch = (
  members: readonly { kind: string; name: string; provider?: string; value?: string }[],
  operation: string,
): Problem | null => {
  for (const { kind, name, provider, value } of members) {
    if (kind !== "ApiKey" || value === undefined) continue;
    const expected = KEY_PREFIXES.find((known) => known.provider === provider);
    if (expected === undefined) continue;
    const issuer = KEY_PREFIXES.find((known) => value.startsWith(known.prefix));
    if (issuer?.provider === expected.provider) continue;
    const found = issuer === undefined ? "the value does not" : `the value is shaped like a key for ${issuer.provider}`;
    return {
      code: "InvalidRequest",
      title: "API key does not match its provider",
      detail: `${operation} refused member ${name}: it is an API key for ${expected.provider}, whose keys start with ${expected.prefix}, and ${found}`,
      fix: `Write an API key from ${expected.provider} into ${name}, or declare the provider that issued the key`,
    };
  }
  return null;
};
