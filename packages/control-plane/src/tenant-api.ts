import {
  ApplyConfigInputSchema,
  ApplyConfigResultSchema,
  CreatePersonaInputSchema,
  CreatePersonaResultSchema,
  CreateSecretSetInputSchema,
  CreateSecretSetResultSchema,
  DeletePersonaInputSchema,
  DeletePersonaResultSchema,
  DeleteSecretSetInputSchema,
  DeleteSecretSetResultSchema,
  GetPersonaInputSchema,
  GetPersonaResultSchema,
  GetSecretSetInputSchema,
  GetSecretSetResultSchema,
  ListPersonasInputSchema,
  ListPersonasResultSchema,
  ListPinsInputSchema,
  ListPinsResultSchema,
  ListSecretSetsInputSchema,
  ListSecretSetsResultSchema,
  OpenInputSchema,
  OpenResultSchema,
  PinInputSchema,
  PinResultSchema,
  RemoveSecretMemberInputSchema,
  RemoveSecretMemberResultSchema,
  SetSecretMemberInputSchema,
  SetSecretMemberResultSchema,
  SupervisorUpdateInputSchema,
  SupervisorUpdateResultSchema,
  SupervisorUpdatesInputSchema,
  SupervisorUpdatesResultSchema,
  TenantApiProtocol,
  TenantRefusalSchema,
  UnpinInputSchema,
  UnpinResultSchema,
  UpdatePersonaInputSchema,
  UpdatePersonaResultSchema,
  UpdateSecretSetInputSchema,
  UpdateSecretSetResultSchema,
} from "@tumpel/schemas";
import { z } from "zod";
import { TenantSkew } from "./tenant-version.ts";

export const TENANT_OPERATIONS = {
  listPersonas: { input: ListPersonasInputSchema, result: ListPersonasResultSchema },
  getPersona: { input: GetPersonaInputSchema, result: GetPersonaResultSchema },
  createPersona: { input: CreatePersonaInputSchema, result: CreatePersonaResultSchema },
  updatePersona: { input: UpdatePersonaInputSchema, result: UpdatePersonaResultSchema },
  deletePersona: { input: DeletePersonaInputSchema, result: DeletePersonaResultSchema },
  open: { input: OpenInputSchema, result: OpenResultSchema },
  supervisorUpdate: { input: SupervisorUpdateInputSchema, result: SupervisorUpdateResultSchema },
  supervisorUpdates: { input: SupervisorUpdatesInputSchema, result: SupervisorUpdatesResultSchema },
  listSecretSets: { input: ListSecretSetsInputSchema, result: ListSecretSetsResultSchema },
  getSecretSet: { input: GetSecretSetInputSchema, result: GetSecretSetResultSchema },
  createSecretSet: { input: CreateSecretSetInputSchema, result: CreateSecretSetResultSchema },
  updateSecretSet: { input: UpdateSecretSetInputSchema, result: UpdateSecretSetResultSchema },
  setSecretMember: { input: SetSecretMemberInputSchema, result: SetSecretMemberResultSchema },
  removeSecretMember: { input: RemoveSecretMemberInputSchema, result: RemoveSecretMemberResultSchema },
  deleteSecretSet: { input: DeleteSecretSetInputSchema, result: DeleteSecretSetResultSchema },
  applyConfig: { input: ApplyConfigInputSchema, result: ApplyConfigResultSchema },
  listPins: { input: ListPinsInputSchema, result: ListPinsResultSchema },
  pin: { input: PinInputSchema, result: PinResultSchema },
  unpin: { input: UnpinInputSchema, result: UnpinResultSchema },
} as const;

type Operations = typeof TENANT_OPERATIONS;
export type TenantOperation = keyof Operations;
export type TenantInput<O extends TenantOperation> = z.infer<Operations[O]["input"]>;
export type TenantResult<O extends TenantOperation> = z.infer<Operations[O]["result"]>;
export type TenantRefusal = z.infer<typeof TenantRefusalSchema>;
export type TenantRequest = { tenantApiVersion: number; operation: string; input: unknown };
export type TenantResponse = { result: unknown } | TenantRefusal;
export type TenantHandlers = {
  [O in TenantOperation]: (input: TenantInput<O>) => TenantResult<O> | Promise<TenantResult<O>>;
};

const EnvelopeSchema = z.object({ tenantApiVersion: z.int(), operation: z.string(), input: z.unknown() });

const known = (operation: string): operation is TenantOperation => Object.hasOwn(TENANT_OPERATIONS, operation);

const invalid = (operation: string, error: z.ZodError): TenantRefusal => ({
  refusal: "TenantRequestInvalid",
  operation,
  issues: error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
});

const run = <O extends TenantOperation>(handlers: TenantHandlers, operation: O, input: unknown) => {
  const parsed = TENANT_OPERATIONS[operation].input.safeParse(input);
  if (!parsed.success) return invalid(operation, parsed.error);
  const handler = handlers[operation] as (input: TenantInput<O>) => TenantResult<O> | Promise<TenantResult<O>>;
  return Promise.resolve(handler(parsed.data as TenantInput<O>)).then((result) => ({ result }));
};

export const serveTenantRequest = async (
  request: unknown,
  handlers: TenantHandlers,
  reset: () => void,
): Promise<TenantResponse> => {
  const envelope = EnvelopeSchema.safeParse(request);
  if (!envelope.success) return invalid("unknown", envelope.error);
  const { tenantApiVersion, operation, input } = envelope.data;
  const stale = tenantApiVersion > TenantApiProtocol.Version || !known(operation);
  if (stale) setTimeout(reset, 0);
  if (tenantApiVersion < TenantApiProtocol.Oldest || tenantApiVersion > TenantApiProtocol.Version) {
    return {
      refusal: "TenantApiVersionUnsupported",
      oldestTenantApiVersion: TenantApiProtocol.Oldest,
      tenantApiVersion: TenantApiProtocol.Version,
    };
  }
  if (!known(operation)) return { refusal: "TenantOperationUnknown", operation };
  return run(handlers, operation, input);
};

type TenantStub = { handle(request: TenantRequest): Promise<TenantResponse> };

const refused = (tenantId: string, operation: string, refusal: TenantRefusal): Error => {
  if (refusal.refusal === "TenantRequestInvalid")
    return new Error(`tenant ${tenantId} refused ${operation} as invalid: ${refusal.issues.join("; ")}`);
  if (refusal.refusal === "TenantOperationUnknown")
    return new TenantSkew(`tenant ${tenantId} runs older code that does not know ${operation}`);
  return new TenantSkew(
    `tenant ${tenantId} serves Tenant API ${refusal.oldestTenantApiVersion} to ${refusal.tenantApiVersion} and this Worker sends ${TenantApiProtocol.Version}`,
  );
};

export const tenantApi = (namespace: { getByName(name: string): TenantStub }, tenantId: string) => ({
  call: async <O extends TenantOperation>(operation: O, input: TenantInput<O>): Promise<TenantResult<O>> => {
    const response = await namespace
      .getByName(tenantId)
      .handle({ tenantApiVersion: TenantApiProtocol.Version, operation, input });
    if ("refusal" in response) throw refused(tenantId, operation, TenantRefusalSchema.parse(response));
    return TENANT_OPERATIONS[operation].result.parse(response.result) as TenantResult<O>;
  },
});
