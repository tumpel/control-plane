import {
  ApplyConfigInputSchema,
  ApplyConfigResultSchema,
  ChooseCircleCIOrganizationInputSchema,
  ChooseCircleCIOrganizationResultSchema,
  CircleCIAuthorizationDeadlineReachedInputSchema,
  CircleCIAuthorizationDeadlineReachedResultSchema,
  ClaudeSetupDeadlineReachedInputSchema,
  ClaudeSetupDeadlineReachedResultSchema,
  ClearConnectorCredentialInputSchema,
  ClearConnectorCredentialResultSchema,
  CompleteCircleCIAuthorizationInputSchema,
  CompleteCircleCIAuthorizationResultSchema,
  ConnectorCallbackInputSchema,
  ConnectorCallbackResultSchema,
  CreateConnectorInputSchema,
  CreateConnectorResultSchema,
  CreatePersonaInputSchema,
  CreatePersonaResultSchema,
  CreateSecretSetInputSchema,
  CreateSecretSetResultSchema,
  DeleteConnectorInputSchema,
  DeleteConnectorResultSchema,
  DeletePersonaInputSchema,
  DeletePersonaResultSchema,
  DeleteSecretSetInputSchema,
  DeleteSecretSetResultSchema,
  GetClaudeSetupInputSchema,
  GetClaudeSetupResultSchema,
  GetConnectorInputSchema,
  GetConnectorResultSchema,
  GetOpenRouterAuthorizationInputSchema,
  GetOpenRouterAuthorizationResultSchema,
  GetPersonaInputSchema,
  GetPersonaResultSchema,
  GetSecretSetInputSchema,
  GetSecretSetResultSchema,
  ListClaudeSetupsInputSchema,
  ListClaudeSetupsResultSchema,
  ListConnectorsInputSchema,
  ListConnectorsResultSchema,
  ListPersonasInputSchema,
  ListPersonasResultSchema,
  ListPinsInputSchema,
  ListPinsResultSchema,
  ListSecretSetsInputSchema,
  ListSecretSetsResultSchema,
  OpenInputSchema,
  OpenResultSchema,
  OpenRouterAuthorizationDeadlineReachedInputSchema,
  OpenRouterAuthorizationDeadlineReachedResultSchema,
  OpenRouterCallbackInputSchema,
  OpenRouterCallbackResultSchema,
  OpenRouterSecretSetsInputSchema,
  OpenRouterSecretSetsResultSchema,
  PinInputSchema,
  PinResultSchema,
  PrepareClaudeSetupInputSchema,
  PrepareClaudeSetupResultSchema,
  RemoveSecretMemberInputSchema,
  RemoveSecretMemberResultSchema,
  RenameConnectorInputSchema,
  RenameConnectorResultSchema,
  ServeConnectorTokenInputSchema,
  ServeConnectorTokenResultSchema,
  SetSecretMemberInputSchema,
  SetSecretMemberResultSchema,
  SetStaticTokenInputSchema,
  SetStaticTokenResultSchema,
  StartCircleCIAuthorizationInputSchema,
  StartCircleCIAuthorizationResultSchema,
  StartClaudeSetupInputSchema,
  StartClaudeSetupResultSchema,
  StartConnectorAuthorizationInputSchema,
  StartConnectorAuthorizationResultSchema,
  StartOpenRouterAuthorizationInputSchema,
  StartOpenRouterAuthorizationResultSchema,
  SubmitClaudeSetupCodeInputSchema,
  SubmitClaudeSetupCodeResultSchema,
  SupervisorUpdateInputSchema,
  SupervisorUpdateResultSchema,
  SupervisorUpdatesInputSchema,
  SupervisorUpdatesResultSchema,
  TenantApiProtocol,
  TenantRefusalSchema,
  UnknownConnectorsInputSchema,
  UnknownConnectorsResultSchema,
  UnpinInputSchema,
  UnpinResultSchema,
  UpdatePersonaInputSchema,
  UpdatePersonaResultSchema,
  UpdateSecretSetInputSchema,
  UpdateSecretSetResultSchema,
  WriteClaudeSetupTokenInputSchema,
  WriteClaudeSetupTokenResultSchema,
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
  listConnectors: { input: ListConnectorsInputSchema, result: ListConnectorsResultSchema },
  getConnector: { input: GetConnectorInputSchema, result: GetConnectorResultSchema },
  createConnector: { input: CreateConnectorInputSchema, result: CreateConnectorResultSchema },
  renameConnector: { input: RenameConnectorInputSchema, result: RenameConnectorResultSchema },
  deleteConnector: { input: DeleteConnectorInputSchema, result: DeleteConnectorResultSchema },
  setStaticToken: { input: SetStaticTokenInputSchema, result: SetStaticTokenResultSchema },
  clearConnectorCredential: {
    input: ClearConnectorCredentialInputSchema,
    result: ClearConnectorCredentialResultSchema,
  },
  startConnectorAuthorization: {
    input: StartConnectorAuthorizationInputSchema,
    result: StartConnectorAuthorizationResultSchema,
  },
  connectorCallback: { input: ConnectorCallbackInputSchema, result: ConnectorCallbackResultSchema },
  serveConnectorToken: { input: ServeConnectorTokenInputSchema, result: ServeConnectorTokenResultSchema },
  unknownConnectors: { input: UnknownConnectorsInputSchema, result: UnknownConnectorsResultSchema },
  startOpenRouterAuthorization: {
    input: StartOpenRouterAuthorizationInputSchema,
    result: StartOpenRouterAuthorizationResultSchema,
  },
  getOpenRouterAuthorization: {
    input: GetOpenRouterAuthorizationInputSchema,
    result: GetOpenRouterAuthorizationResultSchema,
  },
  openRouterCallback: { input: OpenRouterCallbackInputSchema, result: OpenRouterCallbackResultSchema },
  openRouterAuthorizationDeadlineReached: {
    input: OpenRouterAuthorizationDeadlineReachedInputSchema,
    result: OpenRouterAuthorizationDeadlineReachedResultSchema,
  },
  openRouterSecretSets: { input: OpenRouterSecretSetsInputSchema, result: OpenRouterSecretSetsResultSchema },
  startCircleCIAuthorization: {
    input: StartCircleCIAuthorizationInputSchema,
    result: StartCircleCIAuthorizationResultSchema,
  },
  completeCircleCIAuthorization: {
    input: CompleteCircleCIAuthorizationInputSchema,
    result: CompleteCircleCIAuthorizationResultSchema,
  },
  chooseCircleCIOrganization: {
    input: ChooseCircleCIOrganizationInputSchema,
    result: ChooseCircleCIOrganizationResultSchema,
  },
  circleCIAuthorizationDeadlineReached: {
    input: CircleCIAuthorizationDeadlineReachedInputSchema,
    result: CircleCIAuthorizationDeadlineReachedResultSchema,
  },
  startClaudeSetup: { input: StartClaudeSetupInputSchema, result: StartClaudeSetupResultSchema },
  getClaudeSetup: { input: GetClaudeSetupInputSchema, result: GetClaudeSetupResultSchema },
  listClaudeSetups: { input: ListClaudeSetupsInputSchema, result: ListClaudeSetupsResultSchema },
  submitClaudeSetupCode: { input: SubmitClaudeSetupCodeInputSchema, result: SubmitClaudeSetupCodeResultSchema },
  writeClaudeSetupToken: { input: WriteClaudeSetupTokenInputSchema, result: WriteClaudeSetupTokenResultSchema },
  claudeSetupDeadlineReached: {
    input: ClaudeSetupDeadlineReachedInputSchema,
    result: ClaudeSetupDeadlineReachedResultSchema,
  },
  prepareClaudeSetup: { input: PrepareClaudeSetupInputSchema, result: PrepareClaudeSetupResultSchema },
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
