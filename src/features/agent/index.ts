// Agent 工具运行时对外出口。
// 对话层（voidConversation 等）保持平铺；工具系统按子目录导出。

export { bootstrapAgentRuntime } from "./runtimeBootstrap";
export { registerBuiltinTools, listModelToolDefinitions } from "./tools";
export { runAgentToolLoop } from "./loop";
export type { AgentToolLoopOptions, AgentToolLoopResult } from "./loop";
export {
  clearToolRegistry,
  getTool,
  getToolMetadata,
  hasTool,
  listToolMetadata,
  registerTool,
  validateAgainstSchema,
  createToolError
} from "./tools";
export type {
  RiskLevel,
  ToolDefinition,
  ToolError,
  ToolMetadata,
  ToolResult
} from "./tools";

export {
  createTaskPlan,
  listReadyStepIds
} from "./planning";
export type {
  CreateTaskRequest,
  TaskPlan,
  TaskReport,
  TaskStatus,
  TaskStep
} from "./planning";

export {
  planTask,
  runTask
} from "./execution";
export type {
  TaskRunnerOptions,
  TaskRunResult
} from "./execution";

export type {
  ConfirmationDecision,
  ConfirmationRequest
} from "./permissions";

export {
  listActiveResourceLocks,
  releaseTaskResources,
  clearAllResourceLocks
} from "./resources";

export {
  appendExecutionLog,
  listExecutionLogs,
  getTaskProgress,
  subscribeExecutionLogs,
  subscribeTaskProgress,
  clearExecutionObservability
} from "./observability";
export type {
  ExecutionLogEvent,
  TaskProgressSnapshot
} from "./observability";

// 阶段 C/D：浏览器与样板下载任务入口
export {
  runBrowserSearchTask,
  runBrowserAssistSampleTask,
  releaseBrowserSessionForTask
} from "./browser";
export type {
  BrowserSearchTaskOptions,
  BrowserSearchTaskResult,
  BrowserSearchTaskStructuredResult,
  BrowserSearchResultItem,
  BrowserAssistSampleTaskOptions,
  BrowserAssistSampleTaskResult,
  BrowserAssistSampleStructuredResult
} from "./browser";
