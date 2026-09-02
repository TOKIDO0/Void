// 工具子系统对外出口。

export type {
  RiskLevel,
  ToolAuditPolicy,
  ToolCallContext,
  ToolDefinition,
  ToolError,
  ToolErrorCode,
  ToolIdempotency,
  ToolInvocationRequest,
  ToolJsonSchema,
  ToolMetadata,
  ToolResourceRequirement,
  ToolResult
} from "./toolTypes";

export { validateAgainstSchema } from "./toolSchema";
export type { SchemaValidationIssue, SchemaValidationResult } from "./toolSchema";
export { coerceToolArgs } from "./coerceToolArgs";
export { sanitizeToolErrorMessage, SANITIZE_TOOL_ERROR_MAX_LEN } from "./sanitizeToolError";
export { sanitizeParametersSchema } from "./sanitizeToolSchemas";

export {
  clearToolRegistry,
  auditRegisteredToolContracts,
  getTool,
  getToolMetadata,
  hasTool,
  listToolMetadata,
  registerTool
} from "./toolRegistry";

export {
  createToolError,
  formatSchemaIssues,
  isAbortError,
  toExecutionFailedError
} from "./toolErrors";

export {
  fromModelToolName,
  listModelToolDefinitions,
  toModelToolName
} from "./modelToolSchema";
export { registerBuiltinTools } from "./registerBuiltinTools";
export { echoTool } from "./builtin/echoTool";
export type { EchoToolInput, EchoToolOutput } from "./builtin/echoTool";
export { browserOpenTool } from "./builtin/browserOpenTool";
export { browserSearchTool } from "./builtin/browserSearchTool";
export { browserReadResultTool } from "./builtin/browserReadResultTool";
export { browserScreenshotTool } from "./builtin/browserScreenshotTool";
export { browserRevealInSystemBrowserTool } from "./builtin/browserRevealInSystemBrowserTool";
export { browserClickTool } from "./builtin/browserClickTool";
export { browserTypeTool } from "./builtin/browserTypeTool";
export { browserWaitForTool } from "./builtin/browserWaitForTool";
export { browserExtractTool } from "./builtin/browserExtractTool";
export { browserTabsTool } from "./builtin/browserTabsTool";
export { browserSwitchTabTool } from "./builtin/browserSwitchTabTool";
export type {
  BrowserOpenToolInput,
  BrowserOpenToolOutput
} from "./builtin/browserOpenTool";
export type {
  BrowserSearchToolInput,
  BrowserSearchToolOutput
} from "./builtin/browserSearchTool";
export type {
  BrowserReadResultToolInput,
  BrowserReadResultToolOutput
} from "./builtin/browserReadResultTool";
export type {
  BrowserScreenshotToolInput,
  BrowserScreenshotToolOutput
} from "./builtin/browserScreenshotTool";
export type {
  BrowserClickToolInput,
  BrowserClickToolOutput
} from "./builtin/browserClickTool";
export type {
  BrowserTypeToolInput,
  BrowserTypeToolOutput
} from "./builtin/browserTypeTool";
export type {
  BrowserWaitForToolInput,
  BrowserWaitForToolOutput
} from "./builtin/browserWaitForTool";
export type {
  BrowserExtractToolInput,
  BrowserExtractToolOutput
} from "./builtin/browserExtractTool";
export type {
  BrowserTabsToolInput,
  BrowserTabsToolOutput
} from "./builtin/browserTabsTool";
export type {
  BrowserSwitchTabToolInput,
  BrowserSwitchTabToolOutput
} from "./builtin/browserSwitchTabTool";
export { browserSelectTargetTool } from "./builtin/browserSelectTargetTool";
export { fileDownloadToTempTool } from "./builtin/fileDownloadToTempTool";
export { fileDownloadMediaPageTool } from "./builtin/fileDownloadMediaPageTool";
export { filePlaceDownloadTool } from "./builtin/filePlaceDownloadTool";
export { fileVerifyTool } from "./builtin/fileVerifyTool";
export { fileListDirectoryTool } from "./builtin/fileListDirectoryTool";
export { fileInspectPathTool } from "./builtin/fileInspectPathTool";
export { fileFindByNameTool } from "./builtin/fileFindByNameTool";
export { fileListRecentArtifactsTool } from "./builtin/fileListRecentArtifactsTool";
export { fileReadTextTool } from "./builtin/fileReadTextTool";
export { fileSearchTextTool } from "./builtin/fileSearchTextTool";
export { fileInspectWriteTargetTool } from "./builtin/fileInspectWriteTargetTool";
export { fileCreateDirectoryTool } from "./builtin/fileCreateDirectoryTool";
export { fileMoveTool } from "./builtin/fileMoveTool";
export { fileWriteTextTool } from "./builtin/fileWriteTextTool";
export { securityInspectLocalRuntimeTool } from "./builtin/securityInspectLocalRuntimeTool";
export { agentInspectCapabilitiesTool } from "./builtin/agentInspectCapabilitiesTool";
export { agentPlanTaskRouteTool } from "./builtin/agentPlanTaskRouteTool";
export { agentInspectToolContractTool } from "./builtin/agentInspectToolContractTool";
export { agentInspectExtensionPolicyTool } from "./builtin/agentInspectExtensionPolicyTool";
export { agentInspectSafetyHooksTool } from "./builtin/agentInspectSafetyHooksTool";
export { agentInspectPrivacyBoundariesTool } from "./builtin/agentInspectPrivacyBoundariesTool";
export { agentInspectTaskPlaybooksTool } from "./builtin/agentInspectTaskPlaybooksTool";
export { clipboardReadTool } from "./builtin/clipboardReadTool";
export { clipboardWriteTool } from "./builtin/clipboardWriteTool";
export { desktopRevealPathTool } from "./builtin/desktopRevealPathTool";
export { desktopOpenKnownLocationTool } from "./builtin/desktopOpenKnownLocationTool";
export type {
  BrowserSelectTargetToolInput,
  BrowserSelectTargetToolOutput
} from "./builtin/browserSelectTargetTool";
export type {
  FileDownloadToTempToolInput,
  FileDownloadToTempToolOutput
} from "./builtin/fileDownloadToTempTool";
export type {
  FileDownloadMediaPageToolInput,
  FileDownloadMediaPageToolOutput
} from "./builtin/fileDownloadMediaPageTool";
export type {
  FilePlaceDownloadToolInput,
  FilePlaceDownloadToolOutput
} from "./builtin/filePlaceDownloadTool";
export type {
  FileVerifyToolInput,
  FileVerifyToolOutput
} from "./builtin/fileVerifyTool";
export type {
  FileListRecentArtifactsToolInput,
  FileListRecentArtifactsToolOutput
} from "./builtin/fileListRecentArtifactsTool";
export type {
  FileInspectPathToolInput,
  FileInspectPathToolOutput
} from "./builtin/fileInspectPathTool";
export type {
  FileFindByNameToolInput,
  FileFindByNameToolOutput
} from "./builtin/fileFindByNameTool";
export type {
  FileWriteTextToolInput,
  FileWriteTextToolOutput
} from "./builtin/fileWriteTextTool";
export type {
  FileSearchTextToolInput,
  FileSearchTextToolOutput
} from "./builtin/fileSearchTextTool";
export type {
  FileInspectWriteTargetToolInput,
  FileInspectWriteTargetToolOutput
} from "./builtin/fileInspectWriteTargetTool";
export type {
  SecurityInspectLocalRuntimeToolInput,
  SecurityInspectLocalRuntimeToolOutput
} from "./builtin/securityInspectLocalRuntimeTool";
export type {
  AgentInspectCapabilitiesToolInput,
  AgentInspectCapabilitiesToolOutput
} from "./builtin/agentInspectCapabilitiesTool";
export type {
  AgentPlanTaskRouteToolInput,
  AgentPlanTaskRouteToolOutput
} from "./builtin/agentPlanTaskRouteTool";
export type {
  AgentInspectToolContractToolInput,
  AgentInspectToolContractToolOutput
} from "./builtin/agentInspectToolContractTool";
export type {
  AgentInspectExtensionPolicyToolInput,
  AgentInspectExtensionPolicyToolOutput
} from "./builtin/agentInspectExtensionPolicyTool";
export type {
  AgentInspectSafetyHooksToolInput,
  AgentInspectSafetyHooksToolOutput
} from "./builtin/agentInspectSafetyHooksTool";
export type {
  AgentInspectPrivacyBoundariesToolInput,
  AgentInspectPrivacyBoundariesToolOutput
} from "./builtin/agentInspectPrivacyBoundariesTool";
export type {
  AgentInspectTaskPlaybooksToolInput,
  AgentInspectTaskPlaybooksToolOutput
} from "./builtin/agentInspectTaskPlaybooksTool";
export type {
  ClipboardReadToolInput,
  ClipboardReadToolOutput
} from "./builtin/clipboardReadTool";
export type {
  ClipboardWriteToolInput,
  ClipboardWriteToolOutput
} from "./builtin/clipboardWriteTool";
export type {
  DesktopRevealPathToolInput,
  DesktopRevealPathToolOutput
} from "./builtin/desktopRevealPathTool";
export type {
  DesktopOpenKnownLocationToolInput,
  DesktopOpenKnownLocationToolOutput
} from "./builtin/desktopOpenKnownLocationTool";
