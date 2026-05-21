import { contextBridge, ipcRenderer } from "electron";
import type {
  ConfigureProviderProfileInput,
  ConfigureMcpServerInput,
  CalculatorAppendTokenInput,
  CalculatorEvaluateInput,
  CalculatorResultDto,
  CalculatorSetAngleUnitInput,
  CalculatorSetBaseInput,
  CalculatorSetExpressionInput,
  CalculatorSetModeInput,
  CalculatorSetWordSizeInput,
  CalculatorSummaryDto,
  CommandResultDto,
  DesktopActionInput,
  DesktopRestoreInput,
  DesktopPreferencesDto,
  DesktopRefreshEventDto,
  DocumentationPageDto,
  DocumentationPageSummaryDto,
  EntityRefDto,
  EnvironmentEventDto,
  EventSubscriptionHandle,
  EventSubscriptionInput,
  MemoryDeleteInput,
  MemoryDeleteResultDto,
  MemoryEntryDto,
  MemoryListDto,
  MemoryUpdateInput,
  ProviderProfileSummaryDto,
  QueryResultDto,
  McpServerConfigDto,
  DesktopTaskManifestDto,
  DesktopTaskRecordDto,
  RemoveMcpServerInput,
  SbclAgentDesktopApi,
  UpdateProviderRoutingInput,
  UseProviderProfileInput,
  WorkspaceId
} from "../shared/contracts";

const eventHandlers = new Map<string, (event: EnvironmentEventDto) => void>();
const pendingEvents = new Map<string, EnvironmentEventDto[]>();
const refreshHandlers = new Map<string, (event: DesktopRefreshEventDto) => void>();
const conversationStreamHandlers = new Map<string, (event: EnvironmentEventDto) => void>();
const menuActionHandlers = new Map<string, (action: string) => void>();
let nextConversationStreamSubscriptionId = 1;
let nextMenuActionSubscriptionId = 1;
let nextRefreshSubscriptionId = 1;

function emitRefreshEvent(event: DesktopRefreshEventDto): void {
  for (const handler of refreshHandlers.values()) {
    handler(event);
  }
}

function inferRefreshEventFromChannel(
  channel: string,
  payload: unknown,
  result: unknown
): DesktopRefreshEventDto | null {
  const payloadRecord = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const resultRecord = result && typeof result === "object" ? (result as Record<string, unknown>) : null;
  const dataRecord =
    resultRecord?.data && typeof resultRecord.data === "object"
      ? (resultRecord.data as Record<string, unknown>)
      : null;
  const metadataRecord =
    resultRecord?.metadata && typeof resultRecord.metadata === "object"
      ? (resultRecord.metadata as Record<string, unknown>)
      : null;
  const bindingRecord =
    metadataRecord?.binding && typeof metadataRecord.binding === "object"
      ? (metadataRecord.binding as Record<string, unknown>)
      : null;
  const environmentId =
    (payloadRecord?.environmentId as string | undefined) ??
    (bindingRecord?.environmentId as string | undefined) ??
    null;

  const domains =
    channel.startsWith("command:create-project") ||
    channel.startsWith("command:update-project") ||
    channel.startsWith("command:append-project") ||
    channel.startsWith("command:bind-project")
      ? ["projects", "work-items", "artifacts"]
      : channel.startsWith("command:update-incident-remediation-plan")
        ? ["incidents", "work-items"]
        : channel.startsWith("command:resume-work-item") ||
            channel.startsWith("command:quarantine-work-item") ||
            channel.startsWith("command:rollback-work-item") ||
            channel.startsWith("command:complete-work-item-validations") ||
            channel.startsWith("command:steer-work-item")
          ? ["work-items", "incidents", "approvals", "artifacts"]
          : channel.startsWith("command:create-conversation-thread") ||
              channel.startsWith("command:update-conversation-thread") ||
              channel.startsWith("command:send-conversation-message") ||
              channel.startsWith("command:approve-actor-message") ||
              channel.startsWith("command:approve-approval") ||
              channel.startsWith("command:approve-request") ||
              channel.startsWith("command:deny-request")
            ? ["conversations", "approvals", "work-items", "incidents"]
            : channel.startsWith("command:update-memory") || channel.startsWith("command:delete-memory")
              ? ["memory"]
              : channel.startsWith("command:evaluate-in-context") ||
                  channel.startsWith("command:stage-source-change") ||
                  channel.startsWith("command:write-source-file") ||
                  channel.startsWith("command:reload-source-file") ||
                  channel.startsWith("command:desktop-action") ||
                  channel.startsWith("command:desktop-restore")
                ? ["runtime", "browser", "desktop-model"]
                : channel.startsWith("command:configure-provider-profile") ||
                    channel.startsWith("command:use-provider-profile") ||
                    channel.startsWith("command:update-provider-routing")
                  ? ["provider-profiles"]
                  : channel.startsWith("command:configure-mcp-server") ||
                      channel.startsWith("command:remove-mcp-server")
                    ? ["mcp-servers", "desktop-task"]
                    : channel.startsWith("command:install-quicklisp-package") ||
                        channel.startsWith("command:run-qlot-command") ||
                        channel.startsWith("command:add-source-registry-entry") ||
                        channel.startsWith("command:update-source-registry-entry") ||
                        channel.startsWith("command:remove-source-registry-entry") ||
                        channel.startsWith("command:add-local-project") ||
                        channel.startsWith("command:remove-local-project")
                      ? ["package-management", "runtime", "browser"]
                      : channel.startsWith("command:evaluate-calculator") ||
                          channel.startsWith("command:set-calculator-") ||
                          channel.startsWith("command:append-calculator-token") ||
                          channel.startsWith("command:backspace-calculator") ||
                          channel.startsWith("command:clear-calculator")
                        ? ["calculator"]
                        : channel.startsWith("host:load-environment-image") ||
                            channel.startsWith("host:save-environment-image") ||
                            channel.startsWith("host:revert-environment-image")
                          ? ["environment-binding", "desktop-model", "provider-profiles", "package-management"]
                          : [];

  if (domains.length === 0) {
    return null;
  }

  return {
    environmentId,
    domains,
    reason: channel,
    source: "presentation-command",
    timestamp: new Date().toISOString(),
    entityId:
      (dataRecord?.projectId as string | undefined) ??
      (dataRecord?.threadId as string | undefined) ??
      (dataRecord?.workItemId as string | undefined) ??
      null
  };
}

async function invokeCommandWithRefresh<T>(
  channel: string,
  payload?: unknown
): Promise<T> {
  const result = await ipcRenderer.invoke(channel, payload);
  const refreshEvent = inferRefreshEventFromChannel(channel, payload, result);
  if (refreshEvent) {
    emitRefreshEvent(refreshEvent);
  }
  return result as T;
}

ipcRenderer.on(
  "events:subscription-event",
  (_event, payload: { subscriptionId: string; event: EnvironmentEventDto }) => {
    const handler = eventHandlers.get(payload.subscriptionId);
    if (handler) {
      handler(payload.event);
      return;
    }

    const queued = pendingEvents.get(payload.subscriptionId) ?? [];
    queued.push(payload.event);
    pendingEvents.set(payload.subscriptionId, queued);
  }
);

ipcRenderer.on("conversation:stream-event", (_event, payload: EnvironmentEventDto) => {
  for (const handler of conversationStreamHandlers.values()) {
    handler(payload);
  }
});

ipcRenderer.on("menu:action", (_event, payload: { action: string }) => {
  for (const handler of menuActionHandlers.values()) {
    handler(payload.action);
  }
});

const api: SbclAgentDesktopApi = {
  host: {
    getHostStatus: () => ipcRenderer.invoke("host:get-status"),
    getCurrentBinding: () => ipcRenderer.invoke("host:get-current-binding"),
    setEnvironmentBinding: (environmentId: string) =>
      ipcRenderer.invoke("host:set-environment-binding", environmentId),
    getEnvironmentImageRegistry: () => ipcRenderer.invoke("host:get-environment-image-registry"),
    loadEnvironmentImage: (imageIdOrName: string) =>
      invokeCommandWithRefresh("host:load-environment-image", imageIdOrName),
    saveEnvironmentImage: (input: { name: string; overwrite?: boolean }) =>
      invokeCommandWithRefresh("host:save-environment-image", input),
    revertEnvironmentToImage: () => invokeCommandWithRefresh("host:revert-environment-image")
  },
  query: {
    projectList: (environmentId?: string) => ipcRenderer.invoke("query:project-list", environmentId),
    projectDetail: (projectId: string, environmentId?: string) =>
      ipcRenderer.invoke("query:project-detail", projectId, environmentId),
    projectTestingHarnessInventory: (environmentId?: string) =>
      ipcRenderer.invoke("query:project-testing-harness-inventory", environmentId),
    environmentSummary: (environmentId?: string) =>
      ipcRenderer.invoke("query:environment-summary", environmentId),
    environmentStatus: (environmentId?: string) =>
      ipcRenderer.invoke("query:environment-status", environmentId),
    workspaceSummary: (environmentId?: string) =>
      ipcRenderer.invoke("query:workspace-summary", environmentId),
    desktopModel: (environmentId?: string) =>
      ipcRenderer.invoke("query:desktop-model", environmentId),
    environmentBootstrap: (environmentId?: string) =>
      ipcRenderer.invoke("query:environment-bootstrap", environmentId),
    environmentEvents: (input) => ipcRenderer.invoke("query:environment-events", input),
    transcriptWorkspace: (input) => ipcRenderer.invoke("query:transcript-workspace", input),
    consoleLogStream: (input) => ipcRenderer.invoke("query:console-log-stream", input),
    diagnosticReportList: (environmentId?: string) =>
      ipcRenderer.invoke("query:diagnostic-report-list", environmentId),
    diagnosticReportDetail: (reportId: string, environmentId?: string) =>
      ipcRenderer.invoke("query:diagnostic-report-detail", reportId, environmentId),
    artifactList: (environmentId?: string) => ipcRenderer.invoke("query:artifact-list", environmentId),
    artifactDetail: (artifactId: string, environmentId?: string) =>
      ipcRenderer.invoke("query:artifact-detail", artifactId, environmentId),
    conversationWorkspace: (input) => ipcRenderer.invoke("query:conversation-workspace", input),
    threadList: (environmentId?: string) => ipcRenderer.invoke("query:thread-list", environmentId),
    threadDetail: (threadId: string, environmentId?: string) =>
      ipcRenderer.invoke("query:thread-detail", threadId, environmentId),
    turnDetail: (turnId: string, environmentId?: string) =>
      ipcRenderer.invoke("query:turn-detail", turnId, environmentId),
    conversationLatency: (turnId: string, environmentId?: string) =>
      ipcRenderer.invoke("query:conversation-latency", turnId, environmentId),
    memoryList: (environmentId?: string): Promise<QueryResultDto<MemoryListDto>> =>
      ipcRenderer.invoke("query:memory-list", environmentId),
    memoryDetail: (memoryId: string, environmentId?: string): Promise<QueryResultDto<MemoryEntryDto>> =>
      ipcRenderer.invoke("query:memory-detail", memoryId, environmentId),
    runtimeSummary: (environmentId?: string) => ipcRenderer.invoke("query:runtime-summary", environmentId),
    runtimeTelemetrySnapshot: (environmentId?: string) =>
      ipcRenderer.invoke("query:runtime-telemetry-snapshot", environmentId),
    runtimeInspectSymbol: (input) => ipcRenderer.invoke("query:runtime-inspect-symbol", input),
    runtimeEntityDetail: (input) => ipcRenderer.invoke("query:runtime-entity-detail", input),
    packageBrowser: (input) => ipcRenderer.invoke("query:package-browser", input),
    runtimeSymbolPage: (input) => ipcRenderer.invoke("query:runtime-symbol-page", input),
    fileSystemDirectory: (input) => ipcRenderer.invoke("query:file-system-directory", input),
    sourcePreview: (input) => ipcRenderer.invoke("query:source-preview", input),
    approvalRequestList: (environmentId?: string) =>
      ipcRenderer.invoke("query:approval-request-list", environmentId),
    approvalRequestDetail: (requestId: string, environmentId?: string) =>
      ipcRenderer.invoke("query:approval-request-detail", requestId, environmentId),
    incidentList: (environmentId?: string) => ipcRenderer.invoke("query:incident-list", environmentId),
    incidentDetail: (incidentId: string, environmentId?: string) =>
      ipcRenderer.invoke("query:incident-detail", incidentId, environmentId),
    workItemList: (environmentId?: string) => ipcRenderer.invoke("query:work-item-list", environmentId),
    workItemDetail: (workItemId: string, environmentId?: string) =>
      ipcRenderer.invoke("query:work-item-detail", workItemId, environmentId),
    workItemPlan: (workItemId: string, environmentId?: string) =>
      ipcRenderer.invoke("query:work-item-plan", workItemId, environmentId),
    workflowRecordDetail: (workflowRecordId: string, environmentId?: string) =>
      ipcRenderer.invoke("query:workflow-record-detail", workflowRecordId, environmentId),
    orchestrationList: (environmentId?: string) =>
      ipcRenderer.invoke("query:orchestration-list", environmentId),
    orchestrationInbox: (environmentId?: string) =>
      ipcRenderer.invoke("query:orchestration-inbox", environmentId),
    orchestrationFocus: (input?: {
      environmentId?: string;
      planId?: string;
      workflowRecordId?: string;
      workItemId?: string;
    }) => ipcRenderer.invoke("query:orchestration-focus", input),
    orchestrationSnapshot: (input?: {
      environmentId?: string;
      planId?: string;
    }) => ipcRenderer.invoke("query:orchestration-snapshot", input),
    planVerification: (input?: {
      environmentId?: string;
      planId?: string;
    }) => ipcRenderer.invoke("query:plan-verification", input),
    providerProfiles: (environmentId?: string): Promise<QueryResultDto<ProviderProfileSummaryDto>> =>
      ipcRenderer.invoke("query:provider-profiles", environmentId),
    packageManagementSummary: (environmentId?: string) =>
      ipcRenderer.invoke("query:package-management-summary", environmentId),
    desktopTaskManifests: (environmentId?: string): Promise<QueryResultDto<DesktopTaskManifestDto[]>> =>
      ipcRenderer.invoke("query:desktop-task-manifests", environmentId),
    desktopTaskRecords: (environmentId?: string): Promise<QueryResultDto<DesktopTaskRecordDto[]>> =>
      ipcRenderer.invoke("query:desktop-task-records", environmentId),
    desktopTaskPendingApproval: (environmentId?: string) =>
      ipcRenderer.invoke("query:desktop-task-pending-approval", environmentId),
    desktopTaskActorFlow: (input?: {
      environmentId?: string;
      sessionId?: string;
      approvalId?: string;
      pendingActionId?: string;
      actorMessageId?: string;
      scopeId?: string;
      latestOnlyP?: boolean;
    }) => ipcRenderer.invoke("query:desktop-task-actor-flow", input),
    desktopTaskActorSystemPanel: (input?: {
      environmentId?: string;
      sessionId?: string;
    }) => ipcRenderer.invoke("query:desktop-task-actor-system-panel", input),
    desktopTaskActorTrace: (input?: { environmentId?: string; actorRole?: string; actorMessageId?: string; phase?: string; latestOnlyP?: boolean; deadLettersOnlyP?: boolean }) =>
      ipcRenderer.invoke("query:desktop-task-actor-trace", input),
    desktopTaskDeadLetterQueue: (input?: { environmentId?: string; actorRole?: string }) =>
      ipcRenderer.invoke("query:desktop-task-dlq", input),
    mcpServerConfigs: (environmentId?: string): Promise<QueryResultDto<McpServerConfigDto[]>> =>
      ipcRenderer.invoke("query:mcp-server-configs", environmentId),
    mcpServerConfig: (serverId: string, environmentId?: string): Promise<QueryResultDto<McpServerConfigDto>> =>
      ipcRenderer.invoke("query:mcp-server-config", serverId, environmentId),
    calculatorSummary: (environmentId?: string): Promise<QueryResultDto<CalculatorSummaryDto>> =>
      ipcRenderer.invoke("query:calculator-summary", environmentId)
  },
  command: {
    createIntent: (input) => invokeCommandWithRefresh("command:create-intent", input),
    createProject: (input) => invokeCommandWithRefresh("command:create-project", input),
    updateProjectConstitution: (input) => invokeCommandWithRefresh("command:update-project-constitution", input),
    updateProjectDesignSystem: (input) => invokeCommandWithRefresh("command:update-project-design-system", input),
    updateProjectStyleGuide: (input) => invokeCommandWithRefresh("command:update-project-style-guide", input),
    updateProjectTestingStrategy: (input) => invokeCommandWithRefresh("command:update-project-testing-strategy", input),
    updateProjectReleaseReadiness: (input) => invokeCommandWithRefresh("command:update-project-release-readiness", input),
    updateProjectReadinessObligations: (input) => invokeCommandWithRefresh("command:update-project-readiness-obligations", input),
    appendProjectRequirement: (input) => invokeCommandWithRefresh("command:append-project-requirement", input),
    appendProjectFeatureSpecification: (input) =>
      invokeCommandWithRefresh("command:append-project-feature-specification", input),
    appendProjectUserJourney: (input) => invokeCommandWithRefresh("command:append-project-user-journey", input),
    appendProjectArchitectureDecision: (input) =>
      invokeCommandWithRefresh("command:append-project-architecture-decision", input),
    appendProjectSourceRoot: (input) => invokeCommandWithRefresh("command:append-project-source-root", input),
    bindProjectTestingHarness: (input) => invokeCommandWithRefresh("command:bind-project-testing-harness", input),
    appendProjectQualityGate: (input) => invokeCommandWithRefresh("command:append-project-quality-gate", input),
    updateIncidentRemediationPlan: (input) =>
      invokeCommandWithRefresh("command:update-incident-remediation-plan", input),
    resumeWorkItem: (input) => invokeCommandWithRefresh("command:resume-work-item", input),
    quarantineWorkItem: (input) => invokeCommandWithRefresh("command:quarantine-work-item", input),
    rollbackWorkItem: (input) => invokeCommandWithRefresh("command:rollback-work-item", input),
    completeWorkItemValidations: (input) => invokeCommandWithRefresh("command:complete-work-item-validations", input),
    steerWorkItem: (input) => invokeCommandWithRefresh("command:steer-work-item", input),
    createConversationThread: (input) => invokeCommandWithRefresh("command:create-conversation-thread", input),
    updateConversationThread: (input) => invokeCommandWithRefresh("command:update-conversation-thread", input),
    updateMemory: (input: MemoryUpdateInput): Promise<CommandResultDto<MemoryEntryDto>> =>
      invokeCommandWithRefresh("command:update-memory", input),
    deleteMemory: (input: MemoryDeleteInput): Promise<CommandResultDto<MemoryDeleteResultDto>> =>
      invokeCommandWithRefresh("command:delete-memory", input),
    sendConversationMessage: (input) => invokeCommandWithRefresh("command:send-conversation-message", input),
    approveActorMessage: (input) => invokeCommandWithRefresh("command:approve-actor-message", input),
    approveApproval: (input) => invokeCommandWithRefresh("command:approve-approval", input),
    extractConversationAttachmentText: (input) =>
      ipcRenderer.invoke("command:extract-conversation-attachment-text", input),
    evaluateInContext: (input) => invokeCommandWithRefresh("command:evaluate-in-context", input),
    evaluateCalculator: (input: CalculatorEvaluateInput): Promise<CommandResultDto<CalculatorResultDto>> =>
      invokeCommandWithRefresh("command:evaluate-calculator", input),
    setCalculatorExpression: (input: CalculatorSetExpressionInput): Promise<CommandResultDto<CalculatorSummaryDto>> =>
      invokeCommandWithRefresh("command:set-calculator-expression", input),
    appendCalculatorToken: (input: CalculatorAppendTokenInput): Promise<CommandResultDto<CalculatorSummaryDto>> =>
      invokeCommandWithRefresh("command:append-calculator-token", input),
    backspaceCalculator: (environmentId: string): Promise<CommandResultDto<CalculatorSummaryDto>> =>
      invokeCommandWithRefresh("command:backspace-calculator", environmentId),
    clearCalculator: (environmentId: string): Promise<CommandResultDto<CalculatorSummaryDto>> =>
      invokeCommandWithRefresh("command:clear-calculator", environmentId),
    setCalculatorMode: (input: CalculatorSetModeInput): Promise<CommandResultDto<CalculatorSummaryDto>> =>
      invokeCommandWithRefresh("command:set-calculator-mode", input),
    setCalculatorBase: (input: CalculatorSetBaseInput): Promise<CommandResultDto<CalculatorSummaryDto>> =>
      invokeCommandWithRefresh("command:set-calculator-base", input),
    setCalculatorWordSize: (input: CalculatorSetWordSizeInput): Promise<CommandResultDto<CalculatorSummaryDto>> =>
      invokeCommandWithRefresh("command:set-calculator-word-size", input),
    setCalculatorAngleUnit: (input: CalculatorSetAngleUnitInput): Promise<CommandResultDto<CalculatorSummaryDto>> =>
      invokeCommandWithRefresh("command:set-calculator-angle-unit", input),
    stageSourceChange: (input) => invokeCommandWithRefresh("command:stage-source-change", input),
    writeSourceFile: (input) => invokeCommandWithRefresh("command:write-source-file", input),
    reloadSourceFile: (input) => invokeCommandWithRefresh("command:reload-source-file", input),
    desktopAction: (input: DesktopActionInput) => invokeCommandWithRefresh("command:desktop-action", input),
    desktopRestore: (input: DesktopRestoreInput) =>
      invokeCommandWithRefresh("command:desktop-restore", input),
    approveRequest: (input) => invokeCommandWithRefresh("command:approve-request", input),
    denyRequest: (input) => invokeCommandWithRefresh("command:deny-request", input),
    configureProviderProfile: (input: ConfigureProviderProfileInput) =>
      invokeCommandWithRefresh("command:configure-provider-profile", input),
    useProviderProfile: (input: UseProviderProfileInput) =>
      invokeCommandWithRefresh("command:use-provider-profile", input),
    updateProviderRouting: (input: UpdateProviderRoutingInput) =>
      invokeCommandWithRefresh("command:update-provider-routing", input),
    configureMcpServer: (input: ConfigureMcpServerInput) =>
      invokeCommandWithRefresh("command:configure-mcp-server", input),
    removeMcpServer: (input: RemoveMcpServerInput) =>
      invokeCommandWithRefresh("command:remove-mcp-server", input),
    installQuicklispPackage: (input) => invokeCommandWithRefresh("command:install-quicklisp-package", input),
    runQlotCommand: (input) => invokeCommandWithRefresh("command:run-qlot-command", input),
    addSourceRegistryEntry: (input) => invokeCommandWithRefresh("command:add-source-registry-entry", input),
    updateSourceRegistryEntry: (input) => invokeCommandWithRefresh("command:update-source-registry-entry", input),
    removeSourceRegistryEntry: (input) => invokeCommandWithRefresh("command:remove-source-registry-entry", input),
    addLocalProject: (input) => invokeCommandWithRefresh("command:add-local-project", input),
    removeLocalProject: (input) => invokeCommandWithRefresh("command:remove-local-project", input)
  },
  events: {
    subscribeEnvironmentEvents: async (
      input: EventSubscriptionInput,
      handler: (event: EnvironmentEventDto) => void
    ): Promise<EventSubscriptionHandle> => {
      const handle = (await ipcRenderer.invoke("events:subscribe", input)) as EventSubscriptionHandle;
      eventHandlers.set(handle.subscriptionId, handler);
      const queued = pendingEvents.get(handle.subscriptionId) ?? [];
      for (const event of queued) {
        handler(event);
      }
      pendingEvents.delete(handle.subscriptionId);
      return handle;
    },
    subscribeRefreshEvents: async (
      handler: (event: DesktopRefreshEventDto) => void
    ): Promise<EventSubscriptionHandle> => {
      const subscriptionId = `refresh-subscription-${nextRefreshSubscriptionId++}`;
      refreshHandlers.set(subscriptionId, handler);
      return { subscriptionId };
    },
    subscribeConversationStream: async (
      handler: (event: EnvironmentEventDto) => void
    ): Promise<EventSubscriptionHandle> => {
      const subscriptionId = `conversation-stream-${nextConversationStreamSubscriptionId++}`;
      conversationStreamHandlers.set(subscriptionId, handler);
      return { subscriptionId };
    },
    unsubscribe: async (subscriptionId: string): Promise<void> => {
      eventHandlers.delete(subscriptionId);
      pendingEvents.delete(subscriptionId);
      if (refreshHandlers.delete(subscriptionId)) {
        return;
      }
      if (menuActionHandlers.delete(subscriptionId)) {
        return;
      }
      if (conversationStreamHandlers.delete(subscriptionId)) {
        return;
      }
      await ipcRenderer.invoke("events:unsubscribe", subscriptionId);
    }
  },
  desktop: {
    focusWorkspace: (workspace: WorkspaceId) =>
      ipcRenderer.invoke("desktop:focus-workspace", workspace),
    getDesktopPreferences: (): Promise<DesktopPreferencesDto> =>
      ipcRenderer.invoke("desktop:get-preferences"),
    setDesktopPreferences: (patch: Partial<DesktopPreferencesDto>): Promise<DesktopPreferencesDto> =>
      ipcRenderer.invoke("desktop:set-preferences", patch),
    quitApp: (): Promise<void> => ipcRenderer.invoke("desktop:quit-app"),
    setWindowTitle: (title: string): Promise<void> => ipcRenderer.invoke("desktop:set-window-title", title),
    openEntityInNewWindow: (ref: EntityRefDto) => ipcRenderer.invoke("desktop:open-entity", ref),
    listDocumentationPages: (): Promise<DocumentationPageSummaryDto[]> =>
      ipcRenderer.invoke("desktop:list-documentation-pages"),
    readDocumentationPage: (slug: string): Promise<DocumentationPageDto> =>
      ipcRenderer.invoke("desktop:read-documentation-page", slug),
    openExternalLink: (url: string): Promise<void> => ipcRenderer.invoke("desktop:open-external-link", url),
    subscribeMenuActions: async (handler: (action: string) => void): Promise<EventSubscriptionHandle> => {
      const subscriptionId = `menu-action-${nextMenuActionSubscriptionId++}`;
      menuActionHandlers.set(subscriptionId, handler);
      return { subscriptionId };
    }
  }
};

contextBridge.exposeInMainWorld("sbclAgentDesktop", api);
