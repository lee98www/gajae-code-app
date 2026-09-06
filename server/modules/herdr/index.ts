export {
  HerdrClient, HerdrError, HerdrRpcError, checkHerdrAbort,
  HERDR_RPC_TIMEOUT_MS, HERDR_MAX_FRAME_BYTES, HERDR_MAX_OUTPUT_BYTES,
  type HerdrConnector, type HerdrDispatchGuard, type HerdrProvisionReceipt,
  type HerdrReportAgentInput, type HerdrReleaseAgentInput,
  type HerdrReportMetadataInput, type HerdrReportMetadataTokenName, type HerdrReportMetadataTokens,
  type HerdrWireWorkspace, type HerdrWireTab, type HerdrWirePane,
  type HerdrWireSnapshot, type HerdrPaneRead,
} from './services/herdr-client.js';
export {
  HerdrSessionsService, getProductionHerdrSessionsService,
  type HerdrSessionsOptions, type HerdrSessionEntry, type HerdrProvisioningHandle,
} from './services/herdr-sessions.js';
export { HerdrManagedAttachClient } from './services/herdr-managed-client.js';
export {
  HerdrAgentReporter, herdrAgentDisplayState,
  type HerdrAgentReporterOptions, type HerdrAgentReporterStatus, type HerdrAgentReporterTarget,
} from './services/herdr-agent-reporter.js';
export {
  HerdrManagedWorkspacesService, getProductionHerdrManagedWorkspacesService,
  type HerdrManagedTrustedOptions, type HerdrManagedWorkspacesOptions,
} from './services/herdr-managed-workspaces.js';
export {
  HerdrManagedChatService, getProductionHerdrManagedChatService,
  type HerdrManagedChatOptions, type ManagedChatConnection, type ManagedChatResult,
  type ManagedChatSend, type ManagedChatControl, type ManagedChatPermissionResponse,
} from './services/herdr-managed-chat.js';
