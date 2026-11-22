import { TriggerStartRefusalSchema, TurnFailedEventSchema, TurnFailureSchema } from "@tumpel/schemas";

export const boundedTo = (max: number | null, detail: string): string =>
  max === null ? detail : detail.slice(0, max).toWellFormed();

export const turnFailureDetail = (detail: string): string =>
  boundedTo(TurnFailureSchema.shape.detail.maxLength, detail);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const storedEvent = (payload: string): Record<string, unknown> => {
  const event: unknown = JSON.parse(payload);
  if (!isRecord(event)) throw new Error(`a stored event payload is not a JSON object: ${payload.slice(0, 200)}`);
  const { detail, refusal } = event;
  return {
    ...event,
    ...(typeof detail === "string" ? { detail: boundedTo(TurnFailedEventSchema.shape.detail.maxLength, detail) } : {}),
    ...(isRecord(refusal) && typeof refusal.detail === "string"
      ? { refusal: { ...refusal, detail: boundedTo(TriggerStartRefusalSchema.shape.detail.maxLength, refusal.detail) } }
      : {}),
  };
};
