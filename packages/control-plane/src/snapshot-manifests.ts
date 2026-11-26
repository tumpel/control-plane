import { z } from "zod";

export const PackListSchema = z.array(z.string());
export const MAX_PACKS_PER_MANIFEST = 16_384;
export const STORE_DELETE_BATCH = 1000;

export const packKey = (tenantId: string, packDigest: string): string => `${tenantId}/packs/${packDigest}`;

export const packListKey = (storageKey: string): string => `${storageKey}.packs`;

export const draftKey = (storageKey: string): string => `${storageKey}.draft`;

const issues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");

const packList = async (
  store: R2Bucket,
  storageKey: string,
): Promise<{ kind: "Read"; value: ReadonlySet<string> } | { kind: "Unreadable"; detail: string } | null> => {
  const listed = await store.get(packListKey(storageKey));
  if (listed === null) return null;
  const parsed = PackListSchema.safeParse(parsedJson(await listed.text()));
  if (!parsed.success) {
    return { kind: "Unreadable", detail: `the pack list of ${storageKey} is no list: ${issues(parsed.error)}` };
  }
  return { kind: "Read", value: new Set(parsed.data) };
};

const SnapshotDraftSchema = z.object({
  lastPart: z.number().int().min(1),
  packs: z.array(z.string()),
});

type SnapshotDraft = z.infer<typeof SnapshotDraftSchema>;

export const mergedDraft = (
  draft: SnapshotDraft | null,
  part: number,
  packs: string[],
): { kind: "Merged"; draft: SnapshotDraft } | { kind: "Refused"; detail: string } => {
  const continues = draft !== null && (part === draft.lastPart || part === draft.lastPart + 1);
  if (part !== 1 && !continues) {
    return {
      kind: "Refused",
      detail: `but the control plane expects part ${draft === null ? 1 : draft.lastPart + 1}, so the snapshot cannot name its packs`,
    };
  }
  const merged = new Set([...(part === 1 || draft === null ? [] : draft.packs), ...packs]);
  if (merged.size > MAX_PACKS_PER_MANIFEST) {
    return {
      kind: "Refused",
      detail: `which brings it to ${merged.size} packs, above the ${MAX_PACKS_PER_MANIFEST} the control plane indexes, so the snapshot cannot name its packs`,
    };
  }
  return { kind: "Merged", draft: { lastPart: part, packs: [...merged] } };
};

export const snapshotDraft = async (store: R2Bucket, storageKey: string): Promise<SnapshotDraft | null> => {
  const draft = await store.get(draftKey(storageKey));
  if (draft === null) return null;
  const parsed = SnapshotDraftSchema.safeParse(parsedJson(await draft.text()));
  if (!parsed.success) throw new Error(`the pack draft of ${storageKey} does not parse: ${issues(parsed.error)}`);
  return parsed.data;
};

export const snapshotPackSet = async (store: R2Bucket, storageKey: string): Promise<ReadonlySet<string> | null> => {
  const draft = await snapshotDraft(store, storageKey);
  if (draft !== null) return new Set(draft.packs);
  const claimed = await packList(store, storageKey);
  if (claimed === null) return null;
  if (claimed.kind !== "Read") throw new Error(claimed.detail);
  return claimed.value;
};

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
