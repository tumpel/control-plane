import {
  ApplyConfigInputSchema,
  ApplyConfigResultSchema,
  ArchiveSessionInputSchema,
  ArchiveSessionResultSchema,
  CancelTurnInputSchema,
  CancelTurnResultSchema,
  ClearConnectorCredentialInputSchema,
  ClearConnectorCredentialResultSchema,
  CompleteSubscriptionInputSchema,
  CompleteSubscriptionResultSchema,
  ConnectorCallbackInputSchema,
  ConnectorCallbackResultSchema,
  CreateConnectorInputSchema,
  CreateConnectorResultSchema,
  CreatePersonaInputSchema,
  CreatePersonaResultSchema,
  CreatePushSubscriptionInputSchema,
  CreatePushSubscriptionResultSchema,
  CreateSecretSetInputSchema,
  CreateSecretSetResultSchema,
  CreateSubscriptionInputSchema,
  CreateSubscriptionResultSchema,
  CreateTriggerInputSchema,
  CreateTriggerResultSchema,
  CreateWebhookEndpointInputSchema,
  CreateWebhookEndpointResultSchema,
  DeleteConnectorInputSchema,
  DeleteConnectorResultSchema,
  DeletePersonaInputSchema,
  DeletePersonaResultSchema,
  DeletePushSubscriptionInputSchema,
  DeletePushSubscriptionResultSchema,
  DeleteSecretSetInputSchema,
  DeleteSecretSetResultSchema,
  DeleteSessionInputSchema,
  DeleteSessionResultSchema,
  DeleteSubscriptionInputSchema,
  DeleteSubscriptionResultSchema,
  DeleteTriggerInputSchema,
  DeleteTriggerResultSchema,
  DeleteWebhookEndpointInputSchema,
  DeleteWebhookEndpointResultSchema,
  ForgetHostUsageInputSchema,
  ForgetHostUsageResultSchema,
  GetClaudeSetupInputSchema,
  GetClaudeSetupResultSchema,
  GetConnectorInputSchema,
  GetConnectorResultSchema,
  GetOpenRouterAuthorizationInputSchema,
  GetOpenRouterAuthorizationResultSchema,
  GetPersonaInputSchema,
  GetPersonaResultSchema,
  GetPrebuildFailureInputSchema,
  GetPrebuildFailureResultSchema,
  GetPrebuildInputSchema,
  GetPrebuildResultSchema,
  GetSecretSetInputSchema,
  GetSecretSetResultSchema,
  GetSessionInputSchema,
  GetSessionResultSchema,
  GetSnapshotInputSchema,
  GetSnapshotResultSchema,
  GetSubscriptionInputSchema,
  GetSubscriptionResultSchema,
  GetTriggerInputSchema,
  GetTriggerResultSchema,
  GetTurnFailureInputSchema,
  GetTurnFailureResultSchema,
  GetTurnInputSchema,
  GetTurnResultSchema,
  GetWebhookEndpointInputSchema,
  GetWebhookEndpointResultSchema,
  HeldPrebuildInputSchema,
  HeldPrebuildResultSchema,
  HostHeartbeatInputSchema,
  HostHeartbeatResultSchema,
  HostHelloInputSchema,
  HostHelloResultSchema,
  HostMessageInputSchema,
  HostMessageResultSchema,
  ListClaudeSetupsInputSchema,
  ListClaudeSetupsResultSchema,
  ListConnectorsInputSchema,
  ListConnectorsResultSchema,
  ListCredentialHandoversInputSchema,
  ListCredentialHandoversResultSchema,
  ListEventsInputSchema,
  ListEventsResultSchema,
  ListHostUsageInputSchema,
  ListHostUsageResultSchema,
  ListLatestPrebuildsInputSchema,
  ListLatestPrebuildsResultSchema,
  ListPersonasInputSchema,
  ListPersonasResultSchema,
  ListPinsInputSchema,
  ListPinsResultSchema,
  ListPrebuildsInputSchema,
  ListPrebuildsResultSchema,
  ListPushSubscriptionsInputSchema,
  ListPushSubscriptionsResultSchema,
  ListSecretSetsInputSchema,
  ListSecretSetsResultSchema,
  ListSessionsInputSchema,
  ListSessionsResultSchema,
  ListSnapshotsInputSchema,
  ListSnapshotsResultSchema,
  ListSteersInputSchema,
  ListSteersResultSchema,
  ListStopFailuresInputSchema,
  ListStopFailuresResultSchema,
  ListSubscriptionsInputSchema,
  ListSubscriptionsResultSchema,
  ListTriggersInputSchema,
  ListTriggersResultSchema,
  ListTurnsInputSchema,
  ListTurnsResultSchema,
  ListWebhookEndpointsInputSchema,
  ListWebhookEndpointsResultSchema,
  OpenInputSchema,
  OpenResultSchema,
  OpenRouterCallbackInputSchema,
  OpenRouterCallbackResultSchema,
  OpenRouterSecretSetsInputSchema,
  OpenRouterSecretSetsResultSchema,
  PatchPersonaInputSchema,
  PatchPersonaResultSchema,
  PatchSecretSetInputSchema,
  PatchSecretSetResultSchema,
  PatchSessionTagsInputSchema,
  PatchSessionTagsResultSchema,
  PauseSubscriptionInputSchema,
  PauseSubscriptionResultSchema,
  PersonOriginSchema,
  PinInputSchema,
  PinResultSchema,
  PrepareClaudeSetupInputSchema,
  PrepareClaudeSetupResultSchema,
  PrepareOfferInputSchema,
  PrepareOfferResultSchema,
  ReadLimitsInputSchema,
  ReadLimitsResultSchema,
  ReadUsageInputSchema,
  ReadUsageResultSchema,
  RecordStartRefusalInputSchema,
  RecordStartRefusalResultSchema,
  RemoveSecretMemberInputSchema,
  RemoveSecretMemberResultSchema,
  RenameConnectorInputSchema,
  RenameConnectorResultSchema,
  RepositoryReadTokenInputSchema,
  RepositoryReadTokenResultSchema,
  ResumeSubscriptionInputSchema,
  ResumeSubscriptionResultSchema,
  RunningTurnsByHostInputSchema,
  RunningTurnsByHostResultSchema,
  SendTurnInputSchema,
  SendTurnResultSchema,
  ServeConnectorTokenInputSchema,
  ServeConnectorTokenResultSchema,
  SetLimitsInputSchema,
  SetLimitsResultSchema,
  SetSecretMemberInputSchema,
  SetSecretMemberResultSchema,
  SetSessionTagsInputSchema,
  SetSessionTagsResultSchema,
  SetStaticTokenInputSchema,
  SetStaticTokenResultSchema,
  SetWebhookEndpointStatusInputSchema,
  SetWebhookEndpointStatusResultSchema,
  StartClaudeSetupInputSchema,
  StartClaudeSetupResultSchema,
  StartConnectorAuthorizationInputSchema,
  StartConnectorAuthorizationResultSchema,
  StartHostPrebuildInputSchema,
  StartHostPrebuildResultSchema,
  StartOpenRouterAuthorizationInputSchema,
  StartOpenRouterAuthorizationResultSchema,
  StartSessionFromIssueInputSchema,
  StartSessionFromIssueResultSchema,
  StartSessionInputSchema,
  StartSessionResultSchema,
  SteerTurnInputSchema,
  SteerTurnResultSchema,
  StopSessionInputSchema,
  StopSessionResultSchema,
  SubmitClaudeSetupCodeInputSchema,
  SubmitClaudeSetupCodeResultSchema,
  SupervisorUpdateInputSchema,
  SupervisorUpdateResultSchema,
  SupervisorUpdatesInputSchema,
  SupervisorUpdatesResultSchema,
  TakeSteersInputSchema,
  TakeSteersResultSchema,
  TenantApiProtocol,
  TenantRefusalSchema,
  TranscriptCursorInputSchema,
  TranscriptCursorResultSchema,
  TriggerFiredInputSchema,
  TriggerFiredResultSchema,
  TurnOriginSchema,
  UnknownConnectorsInputSchema,
  UnknownConnectorsResultSchema,
  UnpinInputSchema,
  UnpinResultSchema,
  UpdatePersonaInputSchema,
  UpdatePersonaResultSchema,
  UpdateSecretSetInputSchema,
  UpdateSecretSetResultSchema,
  UpdateTriggerInputSchema,
  UpdateTriggerResultSchema,
  WriteClaudeSetupTokenInputSchema,
  WriteClaudeSetupTokenResultSchema,
} from "@tumpel/schemas";
import { z } from "zod";
import { problem } from "./http.ts";

export const TENANT_OPERATIONS = {
  listPersonas: { input: ListPersonasInputSchema, result: ListPersonasResultSchema },
  getPersona: { input: GetPersonaInputSchema, result: GetPersonaResultSchema },
  createPersona: { input: CreatePersonaInputSchema, result: CreatePersonaResultSchema },
  updatePersona: { input: UpdatePersonaInputSchema, result: UpdatePersonaResultSchema },
  patchPersona: { input: PatchPersonaInputSchema, result: PatchPersonaResultSchema },
  deletePersona: { input: DeletePersonaInputSchema, result: DeletePersonaResultSchema },
  open: { input: OpenInputSchema, result: OpenResultSchema },
  supervisorUpdate: { input: SupervisorUpdateInputSchema, result: SupervisorUpdateResultSchema },
  supervisorUpdates: { input: SupervisorUpdatesInputSchema, result: SupervisorUpdatesResultSchema },
  listSecretSets: { input: ListSecretSetsInputSchema, result: ListSecretSetsResultSchema },
  getSecretSet: { input: GetSecretSetInputSchema, result: GetSecretSetResultSchema },
  createSecretSet: { input: CreateSecretSetInputSchema, result: CreateSecretSetResultSchema },
  updateSecretSet: { input: UpdateSecretSetInputSchema, result: UpdateSecretSetResultSchema },
  patchSecretSet: { input: PatchSecretSetInputSchema, result: PatchSecretSetResultSchema },
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
  openRouterSecretSets: { input: OpenRouterSecretSetsInputSchema, result: OpenRouterSecretSetsResultSchema },
  startClaudeSetup: { input: StartClaudeSetupInputSchema, result: StartClaudeSetupResultSchema },
  getClaudeSetup: { input: GetClaudeSetupInputSchema, result: GetClaudeSetupResultSchema },
  listClaudeSetups: { input: ListClaudeSetupsInputSchema, result: ListClaudeSetupsResultSchema },
  submitClaudeSetupCode: { input: SubmitClaudeSetupCodeInputSchema, result: SubmitClaudeSetupCodeResultSchema },
  writeClaudeSetupToken: { input: WriteClaudeSetupTokenInputSchema, result: WriteClaudeSetupTokenResultSchema },
  prepareClaudeSetup: { input: PrepareClaudeSetupInputSchema, result: PrepareClaudeSetupResultSchema },
  listPrebuilds: { input: ListPrebuildsInputSchema, result: ListPrebuildsResultSchema },
  listLatestPrebuilds: { input: ListLatestPrebuildsInputSchema, result: ListLatestPrebuildsResultSchema },
  getPrebuild: { input: GetPrebuildInputSchema, result: GetPrebuildResultSchema },
  heldPrebuild: { input: HeldPrebuildInputSchema, result: HeldPrebuildResultSchema },
  startHostPrebuild: { input: StartHostPrebuildInputSchema, result: StartHostPrebuildResultSchema },
  getPrebuildFailure: { input: GetPrebuildFailureInputSchema, result: GetPrebuildFailureResultSchema },
  repositoryReadToken: { input: RepositoryReadTokenInputSchema, result: RepositoryReadTokenResultSchema },
  startSession: { input: StartSessionInputSchema, result: StartSessionResultSchema },
  startSessionFromIssue: { input: StartSessionFromIssueInputSchema, result: StartSessionFromIssueResultSchema },
  sendTurn: { input: SendTurnInputSchema, result: SendTurnResultSchema },
  stopSession: { input: StopSessionInputSchema, result: StopSessionResultSchema },
  cancelTurn: { input: CancelTurnInputSchema, result: CancelTurnResultSchema },
  steerTurn: { input: SteerTurnInputSchema, result: SteerTurnResultSchema },
  listSteers: { input: ListSteersInputSchema, result: ListSteersResultSchema },
  takeSteers: { input: TakeSteersInputSchema, result: TakeSteersResultSchema },
  archiveSession: { input: ArchiveSessionInputSchema, result: ArchiveSessionResultSchema },
  createSubscription: { input: CreateSubscriptionInputSchema, result: CreateSubscriptionResultSchema },
  listSubscriptions: { input: ListSubscriptionsInputSchema, result: ListSubscriptionsResultSchema },
  getSubscription: { input: GetSubscriptionInputSchema, result: GetSubscriptionResultSchema },
  pauseSubscription: { input: PauseSubscriptionInputSchema, result: PauseSubscriptionResultSchema },
  resumeSubscription: { input: ResumeSubscriptionInputSchema, result: ResumeSubscriptionResultSchema },
  deleteSubscription: { input: DeleteSubscriptionInputSchema, result: DeleteSubscriptionResultSchema },
  completeSubscription: { input: CompleteSubscriptionInputSchema, result: CompleteSubscriptionResultSchema },
  createTrigger: { input: CreateTriggerInputSchema, result: CreateTriggerResultSchema },
  listTriggers: { input: ListTriggersInputSchema, result: ListTriggersResultSchema },
  getTrigger: { input: GetTriggerInputSchema, result: GetTriggerResultSchema },
  updateTrigger: { input: UpdateTriggerInputSchema, result: UpdateTriggerResultSchema },
  deleteTrigger: { input: DeleteTriggerInputSchema, result: DeleteTriggerResultSchema },
  triggerFired: { input: TriggerFiredInputSchema, result: TriggerFiredResultSchema },
  setSessionTags: { input: SetSessionTagsInputSchema, result: SetSessionTagsResultSchema },
  patchSessionTags: { input: PatchSessionTagsInputSchema, result: PatchSessionTagsResultSchema },
  deleteSession: { input: DeleteSessionInputSchema, result: DeleteSessionResultSchema },
  getSession: { input: GetSessionInputSchema, result: GetSessionResultSchema },
  listSessions: { input: ListSessionsInputSchema, result: ListSessionsResultSchema },
  listTurns: { input: ListTurnsInputSchema, result: ListTurnsResultSchema },
  getTurn: { input: GetTurnInputSchema, result: GetTurnResultSchema },
  recordStartRefusal: { input: RecordStartRefusalInputSchema, result: RecordStartRefusalResultSchema },
  listEvents: { input: ListEventsInputSchema, result: ListEventsResultSchema },
  listPushSubscriptions: { input: ListPushSubscriptionsInputSchema, result: ListPushSubscriptionsResultSchema },
  createPushSubscription: { input: CreatePushSubscriptionInputSchema, result: CreatePushSubscriptionResultSchema },
  deletePushSubscription: { input: DeletePushSubscriptionInputSchema, result: DeletePushSubscriptionResultSchema },
  listWebhookEndpoints: { input: ListWebhookEndpointsInputSchema, result: ListWebhookEndpointsResultSchema },
  createWebhookEndpoint: { input: CreateWebhookEndpointInputSchema, result: CreateWebhookEndpointResultSchema },
  getWebhookEndpoint: { input: GetWebhookEndpointInputSchema, result: GetWebhookEndpointResultSchema },
  deleteWebhookEndpoint: { input: DeleteWebhookEndpointInputSchema, result: DeleteWebhookEndpointResultSchema },
  setWebhookEndpointStatus: {
    input: SetWebhookEndpointStatusInputSchema,
    result: SetWebhookEndpointStatusResultSchema,
  },
  getTurnFailure: { input: GetTurnFailureInputSchema, result: GetTurnFailureResultSchema },
  listStopFailures: { input: ListStopFailuresInputSchema, result: ListStopFailuresResultSchema },
  listSnapshots: { input: ListSnapshotsInputSchema, result: ListSnapshotsResultSchema },
  listCredentialHandovers: { input: ListCredentialHandoversInputSchema, result: ListCredentialHandoversResultSchema },
  getSnapshot: { input: GetSnapshotInputSchema, result: GetSnapshotResultSchema },
  transcriptCursor: { input: TranscriptCursorInputSchema, result: TranscriptCursorResultSchema },
  hostHello: { input: HostHelloInputSchema, result: HostHelloResultSchema },
  hostHeartbeat: { input: HostHeartbeatInputSchema, result: HostHeartbeatResultSchema },
  forgetHostUsage: { input: ForgetHostUsageInputSchema, result: ForgetHostUsageResultSchema },
  runningTurnsByHost: { input: RunningTurnsByHostInputSchema, result: RunningTurnsByHostResultSchema },
  listHostUsage: { input: ListHostUsageInputSchema, result: ListHostUsageResultSchema },
  readUsage: { input: ReadUsageInputSchema, result: ReadUsageResultSchema },
  readLimits: { input: ReadLimitsInputSchema, result: ReadLimitsResultSchema },
  setLimits: { input: SetLimitsInputSchema, result: SetLimitsResultSchema },
  prepareOffer: { input: PrepareOfferInputSchema, result: PrepareOfferResultSchema },
  hostMessage: { input: HostMessageInputSchema, result: HostMessageResultSchema },
} as const;

type Operations = typeof TENANT_OPERATIONS;
export type TenantOperation = keyof Operations;
export type TenantInput<O extends TenantOperation> = z.infer<Operations[O]["input"]>;
export type TenantResult<O extends TenantOperation> = z.infer<Operations[O]["result"]>;
export type TenantRefusal = z.infer<typeof TenantRefusalSchema>;
const CallerOriginSchema = z.union([PersonOriginSchema, TurnOriginSchema]);
type CallerOrigin = z.infer<typeof CallerOriginSchema>;
export type TenantRequest = { tenantApiVersion: number; operation: string; input: unknown; caller?: CallerOrigin };
export type TenantResponse = { result: unknown } | TenantRefusal;
export type TenantHandlers = {
  [O in TenantOperation]: (input: TenantInput<O>, caller?: CallerOrigin) => TenantResult<O> | Promise<TenantResult<O>>;
};

const EnvelopeSchema = z.object({
  tenantApiVersion: z.int(),
  operation: z.string(),
  input: z.unknown(),
  caller: CallerOriginSchema.optional(),
});

const known = (operation: string): operation is TenantOperation => Object.hasOwn(TENANT_OPERATIONS, operation);

const invalid = (operation: string, error: z.ZodError): TenantRefusal => ({
  refusal: "TenantRequestInvalid",
  operation,
  issues: error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
});

const run = <O extends TenantOperation>(
  handlers: TenantHandlers,
  operation: O,
  input: unknown,
  caller?: CallerOrigin,
) => {
  const parsed = TENANT_OPERATIONS[operation].input.safeParse(input);
  if (!parsed.success) return invalid(operation, parsed.error);
  const handler = handlers[operation] as (
    input: TenantInput<O>,
    caller?: CallerOrigin,
  ) => TenantResult<O> | Promise<TenantResult<O>>;
  return Promise.resolve(handler(parsed.data as TenantInput<O>, caller)).then((result) => ({ result }));
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
  return run(handlers, operation, input, envelope.data.caller);
};

type TenantStub = { handle(request: TenantRequest): Promise<TenantResponse> };

const refused = (tenantId: string, operation: string, refusal: TenantRefusal): Error => {
  if (refusal.refusal === "TenantLimitReached") return new TenantLimited(tenantId, refusal);
  if (refusal.refusal === "TenantRequestInvalid")
    return new TenantSkew(`tenant ${tenantId} refused ${operation} as invalid: ${refusal.issues.join("; ")}`);
  if (refusal.refusal === "TenantOperationUnknown")
    return new TenantSkew(`tenant ${tenantId} runs older code that does not know ${operation}`);
  return new TenantSkew(
    `tenant ${tenantId} serves Tenant API ${refusal.oldestTenantApiVersion} to ${refusal.tenantApiVersion} and this Worker sends ${TenantApiProtocol.Version}`,
  );
};

export const tenantApi = (
  namespace: { getByName(name: string): TenantStub },
  tenantId: string,
  caller?: CallerOrigin,
) => ({
  call: async <O extends TenantOperation>(operation: O, input: TenantInput<O>): Promise<TenantResult<O>> => {
    const response = await namespace.getByName(tenantId).handle({
      tenantApiVersion: TenantApiProtocol.Version,
      operation,
      input,
      ...(caller === undefined ? {} : { caller }),
    });
    if ("refusal" in response) throw refused(tenantId, operation, TenantRefusalSchema.parse(response));
    const result = TENANT_OPERATIONS[operation].result.safeParse(response.result);
    if (!result.success) {
      throw new TenantSkew(
        `tenant ${tenantId} answered ${operation} with a result this Worker cannot read: ${result.error.message}`,
      );
    }
    return result.data as TenantResult<O>;
  },
});

export class TenantSkew extends Error {}

export type TenantLimitRefusal = Extract<TenantRefusal, { refusal: "TenantLimitReached" }>;

export class TenantLimited extends Error {
  readonly refusal: TenantLimitRefusal;

  constructor(tenantId: string, refusal: TenantLimitRefusal) {
    super(
      `tenant ${tenantId} on the ${refusal.tier} tier spent its limit of ${refusal.limit} ${refusal.measure} per ${refusal.window.toLowerCase()} (${refusal.used} used); it resets at ${refusal.resetsAt}`,
    );
    this.refusal = refusal;
  }
}

export const tenantSkewed = (error: unknown): Response => {
  if (!(error instanceof TenantSkew)) throw error;
  return problem(
    503,
    {
      code: "DeployInProgress",
      title: "Deploy in progress",
      detail: `a deploy of the control plane is rolling out: ${error.message}`,
      fix: "Retry in a minute, once the deploy has rolled out",
    },
    { "retry-after": "30" },
  );
};
