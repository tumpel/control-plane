import { SecretVariableMemberSchema } from "@tumpel/schemas";

export type PlaintextRow = { secret_set_id: string; name: string; provider: string; value: string; updated_at: number };

export type LegacyMember = { row: PlaintextRow; name: string; kind: "ApiKey" | "Variable" };

const LEGACY_KEY_NAMES: Readonly<Record<string, string>> = {
  Anthropic: "ANTHROPIC_API_KEY",
  OpenAi: "OPENAI_API_KEY",
};

const SecretName = SecretVariableMemberSchema.shape.name;

export const legacyName = (name: string): string | null => {
  if (SecretName.safeParse(name).success) return name;
  const replaced = name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const renamed = /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
  return SecretName.safeParse(renamed).success ? renamed : null;
};

const bySet = (rows: readonly PlaintextRow[]): Map<string, PlaintextRow[]> => {
  const sets = new Map<string, PlaintextRow[]>();
  for (const row of rows) sets.set(row.secret_set_id, [...(sets.get(row.secret_set_id) ?? []), row]);
  return sets;
};

const named = (rows: readonly PlaintextRow[]): { row: PlaintextRow; name: string }[] => {
  const ordered = [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const valid = ordered.filter((row) => SecretName.safeParse(row.name).success);
  const taken = new Set(valid.map((row) => row.name));
  const kept = valid.map((row) => ({ row, name: row.name }));
  for (const row of ordered.filter((candidate) => !SecretName.safeParse(candidate.name).success)) {
    const name = legacyName(row.name);
    if (name === null || taken.has(name)) continue;
    taken.add(name);
    kept.push({ row, name });
  }
  return kept;
};

export const legacyMembers = (rows: readonly PlaintextRow[]): LegacyMember[] =>
  [...bySet(rows).values()].flatMap((set) => {
    const kept = named(set);
    const credentials = new Map<string, PlaintextRow>();
    for (const { row, name } of kept) {
      const held = credentials.get(row.provider);
      if (held === undefined || name === LEGACY_KEY_NAMES[row.provider]) {
        credentials.set(row.provider, row);
      }
    }
    return kept.map(({ row, name }) => ({
      row,
      name,
      kind: credentials.get(row.provider) === row ? "ApiKey" : "Variable",
    }));
  });
