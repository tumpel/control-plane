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

export type CredentialRefusal =
  | { kind: "NoCredential"; provider: string; supported: string[] }
  | { kind: "Unsupported"; name: string; credentialKind: string; supported: string[] }
  | { kind: "Expired"; name: string; expiresAt: string };

export type CredentialCheck<T extends SecretKey | SecretMember> =
  | { kind: "Usable"; credential: Credential<T>; variable: string }
  | CredentialRefusal;

export type Dispatch = { kind: "Ready"; variables: DispatchVariable[] } | CredentialRefusal;

const isCredential = <T extends SecretKey | SecretMember>(member: T): member is Credential<T> =>
  member.kind !== "Variable";

export const supportedKinds = (entry: CatalogEntry): string[] => entry.credentialVariables.map(({ kind }) => kind);

export const checkCredential = <T extends SecretKey | SecretMember>(
  entry: CatalogEntry,
  members: readonly T[],
  now: number,
): CredentialCheck<T> => {
  const credential = members.filter(isCredential).find((member) => member.provider === entry.provider);
  if (credential === undefined)
    return { kind: "NoCredential", provider: entry.provider, supported: supportedKinds(entry) };
  const variable = entry.credentialVariables.find(({ kind }) => kind === credential.kind)?.variable;
  if (variable === undefined) {
    return {
      kind: "Unsupported",
      name: credential.name,
      credentialKind: credential.kind,
      supported: supportedKinds(entry),
    };
  }
  if (credential.kind === "SubscriptionToken" && Date.parse(credential.expiresAt) <= now) {
    return { kind: "Expired", name: credential.name, expiresAt: credential.expiresAt };
  }
  return { kind: "Usable", credential, variable };
};

export const dispatchVariables = (entry: CatalogEntry, members: readonly SecretMember[], now: number): Dispatch => {
  const checked = checkCredential(entry, members, now);
  if (checked.kind !== "Usable") return checked;
  const { credential, variable } = checked;
  const others = members
    .filter((member) => member !== credential && member.name !== variable)
    .map((member) => ({ name: member.name, value: member.value }));
  return { kind: "Ready", variables: [{ name: variable, value: credential.value }, ...others] };
};
