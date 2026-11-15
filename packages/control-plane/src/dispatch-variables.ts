import type { HarnessCatalogEntrySchema, SecretSetCreateSchema, SecretSetSchema } from "@tumpel/api/schemas";
import type { z } from "zod";

type CatalogEntry = Pick<z.infer<typeof HarnessCatalogEntrySchema>, "credentials">;
export type AcceptedCredential = CatalogEntry["credentials"][number];
export type SecretMember = z.infer<typeof SecretSetCreateSchema>["secrets"][number];
export type SecretKey = z.infer<typeof SecretSetSchema>["keys"][number];
type Credential<T extends SecretKey | SecretMember> = Exclude<T, { kind: "Variable" }>;

export interface DispatchVariable {
  name: string;
  value: string;
}

export type CredentialRefusal =
  | { kind: "NoCredential"; accepted: AcceptedCredential[] }
  | { kind: "Unsupported"; name: string; credentialKind: string; supported: string[] }
  | { kind: "Expired"; name: string; expiresAt: string };

export type CredentialCheck<T extends SecretKey | SecretMember> =
  | { kind: "Usable"; credential: Credential<T>; variable: string; fixed: DispatchVariable[] }
  | CredentialRefusal;

export type Dispatch = { kind: "Ready"; variables: DispatchVariable[] } | CredentialRefusal;

const isCredential = <T extends SecretKey | SecretMember>(member: T): member is Credential<T> =>
  member.kind !== "Variable";

const accepts = (accepted: AcceptedCredential, member: { provider: string; kind: string }): boolean =>
  accepted.provider === member.provider && accepted.kind === member.kind;

export const checkCredential = <T extends SecretKey | SecretMember>(
  entry: CatalogEntry,
  members: readonly T[],
  now: number,
): CredentialCheck<T> => {
  const credentials = members.filter(isCredential);
  const [held] = entry.credentials.flatMap((accepted) =>
    credentials.filter((member) => accepts(accepted, member)).map((credential) => ({ accepted, credential })),
  );
  if (held === undefined) {
    const unsupported = credentials.find((member) =>
      entry.credentials.some((each) => each.provider === member.provider),
    );
    if (unsupported === undefined) return { kind: "NoCredential", accepted: entry.credentials };
    return {
      kind: "Unsupported",
      name: unsupported.name,
      credentialKind: unsupported.kind,
      supported: entry.credentials.filter((each) => each.provider === unsupported.provider).map((each) => each.kind),
    };
  }
  const { accepted, credential } = held;
  if (credential.kind === "SubscriptionToken" && Date.parse(credential.expiresAt) <= now) {
    return { kind: "Expired", name: credential.name, expiresAt: credential.expiresAt };
  }
  return { kind: "Usable", credential, variable: accepted.variable, fixed: accepted.fixed };
};

export const dispatchVariables = (entry: CatalogEntry, members: readonly SecretMember[], now: number): Dispatch => {
  const checked = checkCredential(entry, members, now);
  if (checked.kind !== "Usable") return checked;
  const { credential, variable, fixed } = checked;
  const others = members
    .filter((member) => member !== credential)
    .map((member) => ({ name: member.name, value: member.value }));
  return { kind: "Ready", variables: [{ name: variable, value: credential.value }, ...fixed, ...others] };
};
