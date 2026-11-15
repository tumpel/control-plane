import type { HarnessCatalogEntrySchema, SecretSetCreateSchema, SecretSetSchema } from "@tumpel/api/schemas";
import type { z } from "zod";

type CatalogEntry = Pick<
  z.infer<typeof HarnessCatalogEntrySchema>,
  "provider" | "credentialVariables" | "providerRoutes"
>;
type ProviderRoute = CatalogEntry["providerRoutes"][number];
export type SecretMember = z.infer<typeof SecretSetCreateSchema>["secrets"][number];
export type SecretKey = z.infer<typeof SecretSetSchema>["keys"][number];
type Credential<T extends SecretKey | SecretMember> = Exclude<T, { kind: "Variable" }>;

export interface DispatchVariable {
  name: string;
  value: string;
}

export type CredentialRefusal =
  | { kind: "NoCredential"; provider: string; supported: string[]; routed: string[] }
  | { kind: "Unsupported"; name: string; credentialKind: string; supported: string[] }
  | { kind: "Expired"; name: string; expiresAt: string };

export type CredentialCheck<T extends SecretKey | SecretMember> =
  | { kind: "Usable"; credential: Credential<T>; variable: string; fixed: DispatchVariable[] }
  | CredentialRefusal;

export type Dispatch = { kind: "Ready"; variables: DispatchVariable[] } | CredentialRefusal;

const isCredential = <T extends SecretKey | SecretMember>(member: T): member is Credential<T> =>
  member.kind !== "Variable";

export const supportedKinds = (entry: CatalogEntry): string[] => entry.credentialVariables.map(({ kind }) => kind);

const routedCheck = <T extends SecretKey | SecretMember>(
  route: ProviderRoute,
  credential: Credential<T>,
): CredentialCheck<T> => {
  const variable = route.variables.find((each) => each.source === "Credential");
  if (variable === undefined) {
    throw new Error(`the catalog route over ${route.provider} names no Credential variable; fix harness-catalog.ts`);
  }
  const fixed = route.variables.flatMap((each) =>
    each.source === "Fixed" ? [{ name: each.name, value: each.value }] : [],
  );
  return { kind: "Usable", credential, variable: variable.name, fixed };
};

export const checkCredential = <T extends SecretKey | SecretMember>(
  entry: CatalogEntry,
  members: readonly T[],
  now: number,
): CredentialCheck<T> => {
  const credentials = members.filter(isCredential);
  const credential = credentials.find((member) => member.provider === entry.provider);
  if (credential === undefined) {
    for (const route of entry.providerRoutes) {
      const routed = credentials.find((member) => member.provider === route.provider && member.kind === "ApiKey");
      if (routed !== undefined) return routedCheck(route, routed);
    }
    return {
      kind: "NoCredential",
      provider: entry.provider,
      supported: supportedKinds(entry),
      routed: entry.providerRoutes.map((route) => route.provider),
    };
  }
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
  return { kind: "Usable", credential, variable, fixed: [] };
};

export const dispatchVariables = (entry: CatalogEntry, members: readonly SecretMember[], now: number): Dispatch => {
  const checked = checkCredential(entry, members, now);
  if (checked.kind !== "Usable") return checked;
  const { credential, variable, fixed } = checked;
  const native = credential.provider === entry.provider ? [] : entry.credentialVariables.map((each) => each.variable);
  const taken = new Set([variable, ...fixed.map(({ name }) => name), ...native]);
  const others = members
    .filter((member) => member !== credential && !taken.has(member.name))
    .map((member) => ({ name: member.name, value: member.value }));
  return { kind: "Ready", variables: [{ name: variable, value: credential.value }, ...fixed, ...others] };
};
