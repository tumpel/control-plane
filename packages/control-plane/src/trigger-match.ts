export type TriggerCondition = { field: string; values: string[] };

export type ConditionVerdict = TriggerCondition & { actual: string[]; holds: boolean };

export type Filled = { prompt: string; missingFields: string[] };

export type ConditionRow = { position: number; field: string; value: string };

const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scalarText = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [JSON.stringify(value)];
  return [];
};

const walk = (value: unknown, path: readonly string[]): string[] => {
  if (Array.isArray(value)) return value.flatMap((element) => walk(element, path));
  const [head, ...rest] = path;
  if (head === undefined) return scalarText(value);
  if (!isRecord(value)) return [];
  return walk(value[head], rest);
};

export const valuesAt = (payload: unknown, field: string): string[] => walk(payload, field.split("."));

export const verdicts = (conditions: readonly TriggerCondition[], payload: unknown): ConditionVerdict[] =>
  conditions.map((condition) => {
    const actual = valuesAt(payload, condition.field);
    return { ...condition, actual, holds: actual.some((value) => condition.values.includes(value)) };
  });

export const matches = (conditions: readonly TriggerCondition[], payload: unknown): boolean =>
  verdicts(conditions, payload).every((verdict) => verdict.holds);

export const fillPrompt = (template: string, payload: unknown): Filled => {
  const missing = new Set<string>();
  const prompt = template.replaceAll(PLACEHOLDER, (placeholder, field: string) => {
    const values = valuesAt(payload, field);
    if (values.length === 0) missing.add(field);
    return values.length === 0 ? placeholder : values.join(", ");
  });
  return { prompt, missingFields: [...missing] };
};

export const conditionRows = (conditions: readonly TriggerCondition[]): ConditionRow[] =>
  conditions.flatMap((condition, position) =>
    [...new Set(condition.values)].map((value) => ({ position, field: condition.field, value })),
  );

export const conditionsOf = (rows: readonly ConditionRow[]): TriggerCondition[] => {
  const byPosition = new Map<number, TriggerCondition>();
  for (const row of rows) {
    const condition = byPosition.get(row.position);
    if (condition === undefined) byPosition.set(row.position, { field: row.field, values: [row.value] });
    else condition.values.push(row.value);
  }
  return [...byPosition].sort(([left], [right]) => left - right).map(([, condition]) => condition);
};
