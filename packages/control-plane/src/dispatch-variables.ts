import type { HarnessCatalogEntrySchema, SecretSetCreateSchema, SecretSetSchema } from "@tumpel/api/schemas";
import type { z } from "zod";

type CatalogEntry = Pick<z.infer<typeof HarnessCatalogEntrySchema>, "provider" | "credentialVariables">;
export type SecretMember = z.infer<typeof SecretSetCreateSchema>["secrets"][number];
export type SecretKey = z.infer<typeof SecretSetSchema>["keys"][number];
type Credential<T extends SecretKey | SecretMember> = Exclude<T, { kind: "Variable" }>;

export interface DispatchVariable {
  name: string;
  value: string;
}

export type Dispatch =
  | { kind: "Ready"; variables: DispatchVariable[] }
  | { kind: "NoCredential"; provider: string }
  | { kind: "Expired"; name: string; expiresAt: string };

const isCredential = <T extends SecretKey | SecretMember>(member: T): member is Credential<T> =>
  member.kind !== "Variable";

export const credentialFor = <T extends SecretKey | SecretMember>(
  entry: CatalogEntry,
  members: readonly T[],
): Credential<T> | undefined => members.filter(isCredential).find((member) => member.provider === entry.provider);

export const variableFor = (entry: CatalogEntry, kind: Credential<SecretKey>["kind"]): string =>
  kind === "ApiKey" ? entry.credentialVariables.apiKey : entry.credentialVariables.subscriptionToken;

export const dispatchVariables = (entry: CatalogEntry, members: readonly SecretMember[], now: number): Dispatch => {
  const credential = credentialFor(entry, members);
  if (credential === undefined) return { kind: "NoCredential", provider: entry.provider };
  if (credential.kind === "SubscriptionToken" && Date.parse(credential.expiresAt) <= now) {
    return { kind: "Expired", name: credential.name, expiresAt: credential.expiresAt };
  }
  const name = variableFor(entry, credential.kind);
  const others = members
    .filter((member) => member !== credential && member.name !== name)
    .map((member) => ({ name: member.name, value: member.value }));
  return { kind: "Ready", variables: [{ name, value: credential.value }, ...others] };
};
